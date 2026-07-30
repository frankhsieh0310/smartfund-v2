import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YahooFinance from "yahoo-finance2";
import { PrismaClient } from "@prisma/client";
import {
  acquireLifecycleLock,
  completeLifecycleRun,
  createLifecycleRun,
  createSummary,
  failLifecycleRun,
  heartbeatLifecycleLock,
  loadLifecycleResumeCheckpoint,
  pauseLifecycleRun,
  persistLifecycleCheckpoint,
  recoverOrphanedLifecycleRun,
  releaseLifecycleLock,
} from "../production/run-lifecycle.ts";

type Stage = "statements" | "dividends" | "corporate-actions" | "all";
type StatementModule = "financials" | "balance-sheet" | "cash-flow";
type StatementPeriod = "annual" | "quarterly";
type FinancialRow = Record<string, unknown> & { date?: Date | number | string; periodType?: string };
type StockTarget = { id: string; yahooSymbol: string; currency: string; exchange: string };

const prisma = new PrismaClient();
const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const args = new Map(process.argv.slice(2).map((value) => {
  const [key, ...rest] = value.replace(/^--/, "").split("=");
  return [key, rest.join("=") || "true"];
}));
const stage = (args.get("stage") ?? "statements") as Stage;
const exchanges = (args.get("exchanges") ?? "TWSE,TPEx,NASDAQ,NYSE,AMEX").split(",").map((value) => value.trim()).filter(Boolean);
const requestedSymbols = new Set((args.get("symbols") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const limit = Number(args.get("limit") ?? 0);
const resumeRequested = args.has("resume");
const checkpointEvery = 10;
const root = process.cwd();

if (!["statements", "dividends", "corporate-actions", "all"].includes(stage)) throw new Error(`Invalid stage: ${stage}`);

function safeSymbol(symbol: string): string { return symbol.replace(/[^A-Za-z0-9._-]/g, "_"); }
function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  if (typeof value === "number") { const result = new Date(value * 1000); return Number.isNaN(result.valueOf()) ? null : result; }
  if (typeof value === "string") { const result = new Date(value); return Number.isNaN(result.valueOf()) ? null : result; }
  return null;
}
function unitFor(key: string): string {
  if (/shares|shareIssued|treasury/i.test(key)) return "SHARES";
  if (/EPS|PerShare/i.test(key)) return "PER_SHARE";
  if (/taxRate|margin|yield|ratio|returnOn/i.test(key)) return "RATIO";
  return "VALUE";
}
function isStageEnabled(candidate: Exclude<Stage, "all">): boolean { return stage === "all" || stage === candidate; }
function errorType(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout/i.test(message)) return "YAHOO_TIMEOUT";
  if (/HTTP_429|HTTP_5\d\d/i.test(message)) return "YAHOO_HTTP_RETRYABLE";
  if (/no timeseries|not found|invalid/i.test(message)) return "YAHOO_NO_DATA";
  return "YAHOO_FINANCIAL_ERROR";
}

async function archive(symbol: string, name: string, payload: unknown): Promise<void> {
  const directory = join(root, "debug", "yahoo-financial", "raw", safeSymbol(symbol));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), JSON.stringify(payload, null, 2));
}

async function ingestStatements(stock: StockTarget): Promise<number> {
  let inserted = 0;
  const modules: StatementModule[] = ["financials", "balance-sheet", "cash-flow"];
  const periods: StatementPeriod[] = ["annual", "quarterly"];
  for (const module of modules) {
    for (const period of periods) {
      const rows = await yahoo.fundamentalsTimeSeries(stock.yahooSymbol, { period1: "2010-01-01", type: period, module }, { validateResult: false }) as FinancialRow[];
      await archive(stock.yahooSymbol, `${module}-${period}`, rows);
    const data = rows.flatMap((row) => {
      const periodEnd = asDate(row.date);
      if (!periodEnd) return [];
      return Object.entries(row).flatMap(([key, value]) => {
        if (["date", "TYPE", "periodType"].includes(key) || typeof value !== "number" || !Number.isFinite(value)) return [];
        return [{
          stockId: stock.id,
          metric: `yahoo.${module}.${key}`,
          periodEnd,
          fiscalPeriod: `${period}:${String(row.periodType ?? "UNKNOWN")}`,
          value,
          unit: unitFor(key),
          currency: stock.currency,
          source: "YAHOO_FINANCIAL_TIMESERIES",
          sourceFactKey: `${stock.yahooSymbol}:${module}:${period}:${key}`,
          sourceDocumentUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(stock.yahooSymbol)}/financials/`,
        }];
      });
    });
    if (data.length) inserted += (await prisma.stockFinancialFact.createMany({ data, skipDuplicates: true })).count;
    }
  }
  return inserted;
}

async function fetchChartEvents(symbol: string): Promise<{ dividends: Record<string, { amount?: number }>; splits: Record<string, { numerator?: number; denominator?: number; splitRatio?: string }> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=div%2Csplits`;
    const response = await fetch(url, { headers: { "User-Agent": "SmartFund Yahoo Financial Ingestion" }, signal: controller.signal });
    if (!response.ok) throw new Error(`YAHOO_CHART_HTTP_${response.status}`);
    const payload = await response.json() as { chart?: { result?: Array<{ events?: { dividends?: Record<string, { amount?: number }>; splits?: Record<string, { numerator?: number; denominator?: number; splitRatio?: string }> } }> } };
    await archive(symbol, "chart-events", payload);
    return payload.chart?.result?.[0]?.events ?? { dividends: {}, splits: {} };
  } finally { clearTimeout(timeout); }
}

async function ingestChartEvents(stock: StockTarget): Promise<number> {
  const events = await fetchChartEvents(stock.yahooSymbol);
  const data = [
    ...(isStageEnabled("dividends") ? Object.entries(events.dividends ?? {}).flatMap(([timestamp, event]) => {
      const value = event.amount;
      return typeof value === "number" && Number.isFinite(value) ? [{ stockId: stock.id, metric: "yahoo.event.cashDividend", periodEnd: new Date(Number(timestamp) * 1000), value, unit: "PER_SHARE", currency: stock.currency, source: "YAHOO_CHART_API", sourceFactKey: `${stock.yahooSymbol}:dividend:${timestamp}` }] : [];
    }) : []),
    ...(isStageEnabled("corporate-actions") ? Object.entries(events.splits ?? {}).flatMap(([timestamp, event]) => {
      const value = typeof event.numerator === "number" && typeof event.denominator === "number" && event.denominator !== 0 ? event.numerator / event.denominator : Number(event.splitRatio?.split(":")[0]) / Number(event.splitRatio?.split(":")[1]);
      return Number.isFinite(value) ? [{ stockId: stock.id, metric: "yahoo.event.splitRatio", periodEnd: new Date(Number(timestamp) * 1000), value, unit: "RATIO", currency: stock.currency, source: "YAHOO_CHART_API", sourceFactKey: `${stock.yahooSymbol}:split:${timestamp}` }] : [];
    }) : []),
  ];
  return data.length ? (await prisma.stockFinancialFact.createMany({ data, skipDuplicates: true })).count : 0;
}

async function recordFailure(jobId: string, stock: StockTarget, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.productionSchedulerFailure.upsert({
    where: { jobId_stockId: { jobId, stockId: stock.id } },
    create: { jobId, stockId: stock.id, symbol: stock.yahooSymbol, lastError: `${errorType(error)}:${message}` },
    update: { symbol: stock.yahooSymbol, lastError: `${errorType(error)}:${message}`, attempts: { increment: 1 }, lastAttemptedAt: new Date() },
  });
}

async function main() {
  const jobId = `yahoo-financial-historical-${stage}`;
  const owner = randomUUID();
  await recoverOrphanedLifecycleRun(prisma, jobId);
  if (!(await acquireLifecycleLock(prisma, jobId, owner))) { console.log(JSON.stringify({ status: "SKIPPED_LOCKED", jobId })); return; }
  let runId: string | null = null;
  try {
    const allStocks = await prisma.stock.findMany({
      where: { isActive: true, yahooSymbol: { not: "" }, exchange: { in: exchanges }, ...(requestedSymbols.size ? { yahooSymbol: { in: [...requestedSymbols] } } : {}) },
      orderBy: { yahooSymbol: "asc" }, select: { id: true, yahooSymbol: true, currency: true, exchange: true },
    }) as StockTarget[];
    const resume = resumeRequested ? await loadLifecycleResumeCheckpoint(prisma, jobId) : null;
    const resumeIndex = resume?.last_symbol ? allStocks.findIndex((stock) => stock.yahooSymbol === resume.last_symbol) : -1;
    const remaining = allStocks.slice(Math.max(0, resumeIndex + 1));
    const selected = limit > 0 ? remaining.slice(0, limit) : remaining;
    runId = await createLifecycleRun(prisma, jobId, exchanges.join(","), "HISTORICAL");
    const summary = createSummary();
    for (const stock of selected) {
      summary.attempted += 1;
      try {
        let rows = 0;
        if (isStageEnabled("statements")) rows += await ingestStatements(stock);
        if (isStageEnabled("dividends") || isStageEnabled("corporate-actions")) rows += await ingestChartEvents(stock);
        summary.completed += 1; summary.success += 1; summary.inserted += rows;
        await prisma.productionSchedulerFailure.deleteMany({ where: { jobId, stockId: stock.id } });
      } catch (error) {
        summary.failed += 1; summary.retryableFailure += 1;
        await recordFailure(jobId, stock, error);
        console.error(JSON.stringify({ status: "SYMBOL_FAILED", symbol: stock.yahooSymbol, error: error instanceof Error ? error.message : String(error) }));
      }
      if (summary.attempted % checkpointEvery === 0) await persistLifecycleCheckpoint(prisma, runId, summary, stock.yahooSymbol);
      await heartbeatLifecycleLock(prisma, jobId, owner);
    }
    const lastSymbol = selected.at(-1)?.yahooSymbol ?? resume?.last_symbol ?? "";
    if (lastSymbol) await persistLifecycleCheckpoint(prisma, runId, summary, lastSymbol);
    const factCount = selected.length ? await prisma.stockFinancialFact.count({ where: { stockId: { in: selected.map((stock) => stock.id) }, source: { in: ["YAHOO_FINANCIAL_TIMESERIES", "YAHOO_CHART_API"] } } }) : 0;
    if (limit > 0 && selected.length < remaining.length) {
      await pauseLifecycleRun(prisma, runId);
      console.log(JSON.stringify({ status: "PAUSED_LIMIT", jobId, stage, universe: allStocks.length, ...summary, checkpoint: lastSymbol || null, factCount }));
      return;
    }
    await completeLifecycleRun(prisma, runId, summary, null, { status: "PASS", universe: allStocks.length, processed: summary.attempted, factCount, stage, checkpoint: lastSymbol || null });
    console.log(JSON.stringify({ status: "COMPLETE", jobId, stage, universe: allStocks.length, ...summary, checkpoint: lastSymbol || null, factCount }));
  } catch (error) {
    if (runId) await failLifecycleRun(prisma, runId, error);
    throw error;
  } finally { await releaseLifecycleLock(prisma, jobId, owner); }
}

main().finally(() => prisma.$disconnect());
