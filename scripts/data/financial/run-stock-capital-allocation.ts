import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const SOURCE = "SMARTFUND_DERIVED_CAPITAL_ALLOCATION_V1";
const OFFICIAL_SOURCES = ["SEC_EDGAR", "SEC_EDGAR_COMPANYFACTS"];
const ROOT = path.resolve("runtime", "stock-capital-allocation");
const CHECKPOINT_PATH = path.join(ROOT, "checkpoint.json");
const STATUS_PATH = path.join(ROOT, "status.json");
const LOCK_PATH = path.join(ROOT, "worker.lock");
const CANARY = process.argv.includes("--canary");
const ONCE = process.argv.includes("--once") || CANARY;
const BATCH_SIZE = CANARY ? 1 : Math.max(1, Math.min(5, Number(process.env.CAPITAL_ALLOCATION_BATCH_SIZE ?? 5)));
const CYCLE_MS = Math.max(900_000, Number(process.env.CAPITAL_ALLOCATION_CYCLE_MS ?? 21_600_000));
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL ?? process.env.DIRECT_URL } } });

type Checkpoint = { cursor: string | null; processed: number; persisted: number; constrained: number; updatedAt: string };
type Fact = { metric: string; periodStart: Date | null; periodEnd: Date; fiscalPeriod: string | null; formType: string | null; filingDate: Date | null; publicationDate: Date | null; value: unknown; unit: string; currency: string | null; source: string; sourceFactKey: string; sourceDocumentUrl: string | null };
type Derived = { metric: string; value: number; unit: string; inputs: Fact[] };

const iso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function jsonFile<T>(file: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return fallback; } }
async function save(file: string, value: unknown): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function annual(facts: Fact[], metric: string): Fact[] {
  return facts.filter((f) => f.metric === metric && ["10-K", "20-F", "40-F"].includes(f.formType ?? "") && f.periodStart)
    .sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime() || (b.filingDate?.getTime() ?? 0) - (a.filingDate?.getTime() ?? 0));
}
function samePeriod(anchor: Fact, candidates: Fact[]): Fact | undefined {
  return candidates.find((f) => f.periodEnd.getTime() === anchor.periodEnd.getTime() && f.periodStart?.getTime() === anchor.periodStart?.getTime() && f.currency === anchor.currency && f.unit === anchor.unit);
}
function calculate(facts: Fact[]): { observations: Derived[]; constrained: string[]; periodEnd: string | null } {
  const ocf = annual(facts, "operating_cash_flow")[0];
  if (!ocf) return { observations: [], constrained: ["operating_cash_flow"], periodEnd: null };
  const capex = samePeriod(ocf, annual(facts, "capital_expenditure"));
  const revenue = samePeriod(ocf, annual(facts, "revenue"));
  const netIncome = samePeriod(ocf, annual(facts, "net_income"));
  const constrained: string[] = [];
  if (!capex) constrained.push("capital_expenditure");
  if (!revenue) constrained.push("revenue");
  if (!netIncome) constrained.push("net_income");
  const observations: Derived[] = [];
  if (capex) {
    const fcf = Number(ocf.value) - Math.abs(Number(capex.value));
    if (Number.isFinite(fcf)) observations.push({ metric: "capital_allocation.free_cash_flow", value: fcf, unit: ocf.unit, inputs: [ocf, capex] });
    if (revenue && Number(revenue.value) !== 0) observations.push({ metric: "capital_allocation.capex_to_sales", value: Math.abs(Number(capex.value)) / Number(revenue.value), unit: "RATIO", inputs: [capex, revenue] });
    if (netIncome && Number(netIncome.value) !== 0) observations.push({ metric: "capital_allocation.fcf_conversion", value: fcf / Number(netIncome.value), unit: "RATIO", inputs: [ocf, capex, netIncome] });
  }
  return { observations: observations.filter((o) => Number.isFinite(o.value)), constrained, periodEnd: ocf.periodEnd.toISOString().slice(0, 10) };
}

async function persist(stockId: string, derived: Derived[]): Promise<number> {
  let count = 0;
  for (const row of derived) {
    const anchor = row.inputs[0];
    const sourceFactKey = `CAPITAL_ALLOCATION_V1:${row.metric}:${anchor.periodEnd.toISOString().slice(0, 10)}:${row.inputs.map((i) => i.sourceFactKey).sort().join("|")}`;
    const dates = row.inputs.flatMap((i) => i.filingDate ? [i.filingDate] : []);
    const filingDate = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
    await prisma.stockFinancialFact.upsert({
      where: { stockId_metric_periodEnd_source_sourceFactKey: { stockId, metric: row.metric, periodEnd: anchor.periodEnd, source: SOURCE, sourceFactKey } },
      create: { id: randomUUID(), stockId, metric: row.metric, periodStart: anchor.periodStart, periodEnd: anchor.periodEnd, fiscalPeriod: anchor.fiscalPeriod, formType: anchor.formType, filingDate, publicationDate: filingDate, value: row.value, unit: row.unit, currency: row.unit === "RATIO" ? null : anchor.currency, source: SOURCE, sourceFactKey, sourceDocumentUrl: anchor.sourceDocumentUrl, restatementVersion: `METHODOLOGY_V1:${row.inputs.map((i) => i.sourceFactKey).sort().join("|")}` },
      update: { value: row.value, filingDate, publicationDate: filingDate, sourceDocumentUrl: anchor.sourceDocumentUrl, restatementVersion: `METHODOLOGY_V1:${row.inputs.map((i) => i.sourceFactKey).sort().join("|")}` },
    });
    count += 1;
  }
  return count;
}

async function processBatch(checkpoint: Checkpoint) {
  const stocks = await prisma.stock.findMany({
    where: { isActive: true, ...(CANARY ? { ticker: "AAPL", exchange: "NASDAQ" } : checkpoint.cursor ? { id: { gt: checkpoint.cursor } } : {}) },
    select: { id: true, ticker: true, companyName: true, exchange: true }, orderBy: { id: "asc" }, take: BATCH_SIZE,
  });
  if (!CANARY && stocks.length === 0) checkpoint.cursor = null;
  const results = [];
  for (const stock of stocks) {
    const facts = await prisma.stockFinancialFact.findMany({ where: { stockId: stock.id, source: { in: OFFICIAL_SOURCES }, metric: { in: ["operating_cash_flow", "capital_expenditure", "revenue", "net_income"] } }, select: { metric: true, periodStart: true, periodEnd: true, fiscalPeriod: true, formType: true, filingDate: true, publicationDate: true, value: true, unit: true, currency: true, source: true, sourceFactKey: true, sourceDocumentUrl: true }, orderBy: [{ periodEnd: "desc" }, { filingDate: "desc" }], take: 500 }) as Fact[];
    const calculated = calculate(facts);
    const persisted = await persist(stock.id, calculated.observations);
    const readback = persisted ? await prisma.stockFinancialFact.count({ where: { stockId: stock.id, source: SOURCE, periodEnd: calculated.periodEnd ? new Date(`${calculated.periodEnd}T00:00:00.000Z`) : undefined, metric: { in: calculated.observations.map((o) => o.metric) } } }) : 0;
    checkpoint.cursor = stock.id; checkpoint.processed += 1; checkpoint.persisted += persisted; if (!persisted) checkpoint.constrained += 1; checkpoint.updatedAt = iso();
    results.push({ company: `${stock.ticker} — ${stock.companyName}`, stockId: stock.id, inputFacts: facts.length, periodEnd: calculated.periodEnd, metrics: calculated.observations.map((o) => o.metric), persisted, readback, constrained: calculated.constrained });
    await save(CHECKPOINT_PATH, checkpoint);
  }
  return results;
}

async function run(): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const lock = await open(LOCK_PATH, "wx");
  try {
    const checkpoint = await jsonFile<Checkpoint>(CHECKPOINT_PATH, { cursor: null, processed: 0, persisted: 0, constrained: 0, updatedAt: iso() });
    do {
      const results = await processBatch(checkpoint);
      await save(STATUS_PATH, { asset: "GLOBAL_STOCK", layer: "CAPITAL_ALLOCATION_HISTORY", runState: ONCE ? "COMPLETE" : "RUNNING", processId: process.pid, source: "EXISTING_OFFICIAL_FINANCIAL_FACTS", maxDbConcurrency: 1, dbPoolMode: "SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER", results, checkpoint, heartbeatAt: iso(), nextRunAt: ONCE ? null : new Date(Date.now() + CYCLE_MS).toISOString(), autoContinuing: !ONCE });
      if (ONCE) break;
      await sleep(CYCLE_MS);
    } while (true);
  } finally { await lock.close(); await unlink(LOCK_PATH).catch(() => undefined); await prisma.$disconnect(); }
}

run().catch(async (error) => { await save(STATUS_PATH, { asset: "GLOBAL_STOCK", layer: "CAPITAL_ALLOCATION_HISTORY", runState: "BLOCKED", processId: process.pid, lastError: error instanceof Error ? error.message : String(error), updatedAt: iso() }).catch(() => undefined); await prisma.$disconnect().catch(() => undefined); process.exitCode = 1; });
