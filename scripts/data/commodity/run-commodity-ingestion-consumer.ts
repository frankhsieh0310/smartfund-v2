import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as XLSX from "xlsx";
import { prisma } from "../../../lib/prisma.ts";

type QueueEvent = {
  eventId: string;
  source?: string;
  sourceId?: string;
  scope?: string;
  eventType?: string;
  scheduledAt: string;
  sourceReference?: string;
  status: "READY" | "COMPLETED" | "FAILED_ISOLATED";
};
type Checkpoint = {
  source: string;
  scope: string;
  lastSourceState: string | null;
  lastCanonicalState: string | null;
  lastProcessedEvent: string | null;
  lastSuccessfulRun: string | null;
  nextEligibleAt: string | null;
  attempts: number;
};

const root = process.cwd();
const runtime = path.join(root, "runtime", "commodity");
const incrementalDirectory = path.join(runtime, "incremental");
const checkpointPath = path.join(incrementalDirectory, "checkpoint.json");
const latestPath = path.join(runtime, "latest.json");
const queuePath = path.join(runtime, "production-event-queue.jsonl");
const workbookUrl = "https://thedocs.worldbank.org/en/doc/5d903e848db1d1b83e0ec8f744e55570-0350012021/related/CMO-Historical-Data-Monthly.xlsx";
const source = "WORLD_BANK_PINK_SHEET";
const scope = "COMMODITY_SPOT";
const symbol = "WB_BRENT_SPOT";
const canary = process.argv.includes("--canary");
const execFileAsync = promisify(execFile);

async function atomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}
async function checkpoint(): Promise<Checkpoint> {
  try { return JSON.parse(await readFile(checkpointPath, "utf8")); }
  catch { return { source, scope, lastSourceState: null, lastCanonicalState: null, lastProcessedEvent: null, lastSuccessfulRun: null, nextEligibleAt: null, attempts: 0 }; }
}

async function fetchWorkbook() {
  const response = await fetch(workbookUrl, {
    headers: { "user-agent": "SmartFund-Commodity-Ingestion/1.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`WORLD_BANK_FETCH_HTTP_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}

function parseLatestBrent(bytes: Buffer) {
  const workbook = XLSX.read(bytes, { type: "buffer", raw: true });
  const sheet = workbook.Sheets["Monthly Prices"];
  if (!sheet) throw new Error("WORLD_BANK_MONTHLY_PRICES_SHEET_MISSING");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, blankrows: false });
  const headerIndex = rows.findIndex((row) => row.some((value) => String(value).trim() === "Crude oil, Brent"));
  if (headerIndex < 0) throw new Error("WORLD_BANK_BRENT_HEADER_MISSING");
  const column = rows[headerIndex].findIndex((value) => String(value).trim() === "Crude oil, Brent");
  for (let index = rows.length - 1; index > headerIndex; index--) {
    const period = String(rows[index]?.[0] ?? "").trim();
    const match = /^(\d{4})M(\d{2})$/.exec(period);
    const value = Number(rows[index]?.[column]);
    if (!match || !Number.isFinite(value) || value <= 0) continue;
    const date = `${match[1]}-${match[2]}-01`;
    return { date, value, unit: "USD/BBL", source };
  }
  throw new Error("WORLD_BANK_BRENT_OBSERVATION_MISSING");
}

async function canonicalWrite(record: ReturnType<typeof parseLatestBrent>) {
  const date = new Date(`${record.date}T00:00:00.000Z`);
  const existing = await prisma.marketData.findUnique({ where: { symbol_date: { symbol, date } } });
  const action = existing && Number(existing.close).toFixed(4) === record.value.toFixed(4) && existing.source === source ? "NO_OP_CURRENT" : "UPSERTED";
  await prisma.marketMaster.upsert({
    where: { symbol },
    create: { symbol, name: "World Bank Brent Crude Oil Spot Benchmark", assetType: "COMMODITY", region: "GLOBAL", currency: "USD", category: "SPOT_BENCHMARK", provider: source, latestClose: record.value, latestDate: date },
    update: { name: "World Bank Brent Crude Oil Spot Benchmark", assetType: "COMMODITY", region: "GLOBAL", currency: "USD", category: "SPOT_BENCHMARK", provider: source, isActive: true, latestClose: record.value, latestDate: date },
  });
  await prisma.marketData.upsert({
    where: { symbol_date: { symbol, date } },
    create: { symbol, name: "World Bank Brent Crude Oil Spot Benchmark", type: "COMMODITY", date, close: record.value, region: "GLOBAL", currency: "USD", source },
    update: { close: record.value, source },
  });
  const readBack = await prisma.marketData.findUnique({ where: { symbol_date: { symbol, date } } });
  if (!readBack || Number(readBack.close).toFixed(4) !== record.value.toFixed(4) || readBack.source !== source) throw new Error("COMMODITY_CANONICAL_READ_BACK_FAILED");
  return { action, canonicalState: `${symbol}:${record.date}:${Number(readBack.close).toFixed(4)}` };
}

async function processEvent(event: QueueEvent) {
  const state = await checkpoint();
  try {
    const fetched = await fetchWorkbook();
    const record = parseLatestBrent(fetched.bytes);
    const written = await canonicalWrite(record);
    const recovery = await execFileAsync(process.execPath, ["--env-file=.env", "--experimental-strip-types", path.join(root, "scripts", "data", "commodity", "run-commodity-p0-depth-recovery.ts"), "--apply"], { cwd: root, env: process.env, timeout: 10 * 60_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const recoveryResult = JSON.parse(recovery.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { status?: string };
    if (recoveryResult.status !== "P0_APPLIED") throw new Error("COMMODITY_P0_RECOVERY_SUBPROCESS_FAILED");
    const completedAt = new Date().toISOString();
    const nextState: Checkpoint = { source, scope, lastSourceState: fetched.hash, lastCanonicalState: written.canonicalState, lastProcessedEvent: event.eventId, lastSuccessfulRun: completedAt, nextEligibleAt: null, attempts: 0 };
    await atomic(checkpointPath, nextState);
    await atomic(latestPath, { symbol, scope, semantics: "SPOT_BENCHMARK", date: record.date, value: record.value, unit: record.unit, source, sourceReference: workbookUrl, canonicalDestination: "MarketMaster/MarketData", canonicalWrite: written.action, readBack: "PASS", updatedAt: completedAt });
    return { ...record, canonicalWrite: written.action, readBack: "PASS", professionalDepthRecovery: recoveryResult.status, sourceState: fetched.hash, completedAt };
  } catch (error) {
    const attempts = state.attempts + 1;
    const delay = Math.min(6 * 60 * 60_000, 30_000 * 2 ** attempts);
    await atomic(checkpointPath, { ...state, lastProcessedEvent: event.eventId, nextEligibleAt: new Date(Date.now() + delay).toISOString(), attempts });
    throw error;
  }
}

async function queueEvents() {
  try { return (await readFile(queuePath, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as QueueEvent); }
  catch { return []; }
}

async function runCanary() {
  const event: QueueEvent = { eventId: `DRY_CANARY:${source}:${new Date().toISOString()}`, source, scope, eventType: "MONTHLY_PUBLICATION", scheduledAt: new Date().toISOString(), sourceReference: workbookUrl, status: "READY" };
  const result = await processEvent(event);
  console.log(JSON.stringify({ status: "CANARY_PASS", event, fetch: "PASS", parse: "PASS", semantics: "PASS", identity: symbol, canonicalDestination: "MarketMaster/MarketData", ...result }));
}

async function runConsumer() {
  await mkdir(incrementalDirectory, { recursive: true });
  for (;;) {
    const events = await queueEvents();
    const terminal = new Set(events.filter((event) => event.status !== "READY").map((event) => event.eventId));
    const pending = events.find((event) => event.status === "READY" && !terminal.has(event.eventId));
    if (!pending) { await new Promise((resolve) => setTimeout(resolve, 15_000)); continue; }
    const eventSource = pending.source ?? pending.sourceId;
    if (eventSource !== source) {
      await appendFile(queuePath, `${JSON.stringify({ ...pending, status: "FAILED_ISOLATED", completedAt: new Date().toISOString(), reason: "SOURCE_NOT_CANONICAL_READY" })}\n`);
      continue;
    }
    try {
      const result = await processEvent(pending);
      await appendFile(queuePath, `${JSON.stringify({ ...pending, status: "COMPLETED", result })}\n`);
    } catch (error) {
      await appendFile(queuePath, `${JSON.stringify({ ...pending, status: "FAILED_ISOLATED", completedAt: new Date().toISOString(), reason: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
}

try { if (canary) await runCanary(); else await runConsumer(); }
finally { await prisma.$disconnect(); }
