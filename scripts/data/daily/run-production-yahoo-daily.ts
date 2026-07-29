import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  acquireLifecycleLock,
  completeLifecycleRun,
  createLifecycleRun,
  createSummary,
  failLifecycleRun,
  loadLifecycleResumeCheckpoint,
  persistLifecycleCheckpoint,
  releaseLifecycleLock,
} from "../production/run-lifecycle";

type YahooCandle = { date: Date; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null; adjClose: number | null };

async function fetchYahooChartPeriod(symbol: string, period1: number, period2: number): Promise<{ candles: YahooCandle[] } | null> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let payload: { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, Array<number | null>>>; adjclose?: Array<{ adjclose?: Array<number | null> }> } }> } };
  try {
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (SmartFund Production Daily)" }, signal: controller.signal });
    if (!response.ok) throw new Error(`YAHOO_CHART_HTTP_${response.status}`);
    payload = await response.json() as typeof payload;
  } finally {
    clearTimeout(timeout);
  }
  const result = payload.chart?.result?.[0];
  if (!result) return null;
  const quote = result.indicators?.quote?.[0] ?? {};
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  return { candles: (result.timestamp ?? []).map((timestamp, index) => ({ date: new Date(timestamp * 1000), open: quote.open?.[index] ?? null, high: quote.high?.[index] ?? null, low: quote.low?.[index] ?? null, close: quote.close?.[index] ?? null, volume: quote.volume?.[index] ?? null, adjClose: adjusted[index] ?? null })) };
}

type Job = {
  id: string;
  exchange: string;
  timezone: string;
  primaryTime: string;
  retryTime: string;
  weekdays: number[];
};
type Config = { jobs: Job[] };
type RunType = "PRIMARY" | "RETRY";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const selectedJob = args.find((value) => value.startsWith("--job="))?.slice(6);
const runAllDue = args.includes("--all-due");
const root = process.cwd();
const CONCURRENCY = 4;
const CHECKPOINT_EVERY = 25;

function clock(timezone: string, now = new Date()): { day: string; time: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
  };
}

async function loadConfig(): Promise<Config> {
  return JSON.parse(await readFile(join(root, "config", "production-yahoo-daily-jobs.json"), "utf8")) as Config;
}

async function lastSuccessDay(jobId: string, timezone: string, runType: RunType): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<{ started_at: Date }[]>(
    'SELECT started_at FROM production_scheduler_runs WHERE job_id = $1 AND run_type = $2 AND status = \'COMPLETED\' ORDER BY started_at DESC LIMIT 1', jobId, runType,
  );
  return rows[0] ? clock(timezone, rows[0].started_at).day : null;
}

function errorType(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("AbortError")) return "YAHOO_TIMEOUT";
  if (message.includes("YAHOO_CHART_HTTP_")) return "YAHOO_HTTP_ERROR";
  if (message.includes("Prisma") || message.includes("database")) return "DATABASE_ERROR";
  return "UNKNOWN_ERROR";
}

function failureClassification(error: unknown): "PERMANENT_UNAVAILABLE" | "RETRYABLE_FAILURE" {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("YAHOO_NO_DATA") || message.includes("YAHOO_CHART_HTTP_404") || message.includes("YAHOO_CHART_HTTP_422")
    ? "PERMANENT_UNAVAILABLE"
    : "RETRYABLE_FAILURE";
}

async function execute(job: Job, runType: RunType): Promise<Record<string, unknown>> {
  let runId = randomUUID();
  const owner = `${process.env.RAILWAY_DEPLOYMENT_ID ?? process.env.HOSTNAME ?? "worker"}:${process.pid}:${runId}`;
  if (!await acquireLifecycleLock(prisma, job.id, owner)) return { jobId: job.id, status: "SKIPPED_LOCKED" };
  const summary = createSummary();
  try {
    const lifecycleRunId = await createLifecycleRun(prisma, job.id, job.exchange, runType);
    runId = lifecycleRunId;
    const failedStockIds = runType === "RETRY"
      ? (await prisma.$queryRawUnsafe<{ stock_id: string }[]>('SELECT stock_id FROM production_scheduler_failures WHERE job_id = $1', job.id)).map((row) => row.stock_id)
      : [];
    const allStocks = await prisma.stock.findMany({
      where: { exchange: job.exchange, isActive: true, yahooSymbol: { not: "" }, latestDate: { not: null }, ...(runType === "RETRY" ? { id: { in: failedStockIds } } : {}) },
      orderBy: { yahooSymbol: "asc" },
      select: { id: true, yahooSymbol: true, latestDate: true },
    });
    const resume = runType === "PRIMARY" ? await loadLifecycleResumeCheckpoint(prisma, job.id) : null;
    const resumeIndex = resume?.last_symbol ? allStocks.findIndex((stock) => stock.yahooSymbol === resume.last_symbol) : -1;
    if (resume?.last_symbol && resumeIndex < 0) throw new Error(`RESUME_SYMBOL_NOT_IN_UNIVERSE:${resume.last_symbol}`);
    if (resume) {
      summary.attempted = resume.processed;
      summary.completed = resume.succeeded;
      summary.failed = resume.failed;
    }
    const stocks = resume ? allStocks.slice(resumeIndex + 1) : allStocks;
    for (let offset = 0; offset < stocks.length; offset += CONCURRENCY) {
      const batch = stocks.slice(offset, offset + CONCURRENCY);
      const outcomes = await Promise.all(batch.map(async (stock) => {
        try {
          const period1 = Math.floor(stock.latestDate!.getTime() / 1000);
          const period2 = Math.floor((Date.now() + 86_400_000) / 1000);
          const chart = await fetchYahooChartPeriod(stock.yahooSymbol, period1, period2);
          if (!chart) throw new Error("YAHOO_NO_DATA");
          const candles = chart.candles;
          let inserted = 0;
          let updated = 0;
          for (const candle of candles.filter((row) => row.close !== null && row.date >= stock.latestDate!)) {
          const date = candle.date;
          const existing = await prisma.stockHistory.findUnique({ where: { stockId_date: { stockId: stock.id, date } }, select: { id: true } });
          await prisma.stockHistory.upsert({
            where: { stockId_date: { stockId: stock.id, date } },
            create: { stockId: stock.id, date, open: candle.open, high: candle.high, low: candle.low, close: candle.close!, adjustedClose: candle.adjClose, volume: candle.volume, source: "YAHOO", sourceSymbol: stock.yahooSymbol, providerMethod: "YAHOO_CHART_API", importedAt: new Date(), updatedAt: new Date() },
            update: { open: candle.open, high: candle.high, low: candle.low, close: candle.close!, adjustedClose: candle.adjClose, volume: candle.volume, source: "YAHOO", sourceSymbol: stock.yahooSymbol, providerMethod: "YAHOO_CHART_API", updatedAt: new Date() },
          });
            if (existing) updated += 1; else inserted += 1;
          }
          const latest = candles.filter((row) => row.close !== null).at(-1);
          if (latest) await prisma.stock.update({ where: { id: stock.id }, data: { latestDate: latest.date, latestClose: latest.close! } });
          await prisma.$executeRawUnsafe('DELETE FROM production_scheduler_failures WHERE job_id = $1 AND stock_id = $2', job.id, stock.id);
          const noUpdate = inserted + updated === 0 ? 1 : 0;
          return { completed: 1, inserted, updated, failed: 0, success: noUpdate ? 0 : 1, noUpdate, permanentUnavailable: 0, retryableFailure: 0 };
        } catch (error) {
          const classification = failureClassification(error);
          await prisma.$executeRawUnsafe("INSERT INTO production_scheduler_failures (job_id, stock_id, symbol, attempts, last_error, error_type, last_attempted_at, next_retry_at, classification, resolved, resolution_reason) VALUES ($1, $2, $3, 1, $4, $5, NOW(), CASE WHEN $6 = 'RETRYABLE_FAILURE' THEN NOW() + INTERVAL '15 minutes' ELSE NULL END, $6, $6 = 'PERMANENT_UNAVAILABLE', CASE WHEN $6 = 'PERMANENT_UNAVAILABLE' THEN $5 ELSE NULL END) ON CONFLICT (job_id, stock_id) DO UPDATE SET attempts = production_scheduler_failures.attempts + 1, last_error = EXCLUDED.last_error, error_type = EXCLUDED.error_type, classification = EXCLUDED.classification, resolved = EXCLUDED.resolved, resolution_reason = EXCLUDED.resolution_reason, last_attempted_at = NOW(), next_retry_at = EXCLUDED.next_retry_at", job.id, stock.id, stock.yahooSymbol, error instanceof Error ? error.message : String(error), errorType(error), classification);
          return { completed: 0, inserted: 0, updated: 0, failed: 1, success: 0, noUpdate: 0, permanentUnavailable: classification === "PERMANENT_UNAVAILABLE" ? 1 : 0, retryableFailure: classification === "RETRYABLE_FAILURE" ? 1 : 0 };
        }
      }));
      for (const outcome of outcomes) {
        summary.attempted += 1;
        summary.completed += outcome.completed;
        summary.inserted += outcome.inserted;
        summary.updated += outcome.updated;
        summary.failed += outcome.failed;
        summary.success += outcome.success;
        summary.noUpdate += outcome.noUpdate;
        summary.permanentUnavailable += outcome.permanentUnavailable;
        summary.retryableFailure += outcome.retryableFailure;
      }
      if ((offset + batch.length) % CHECKPOINT_EVERY === 0 || offset + batch.length === stocks.length) {
        await persistLifecycleCheckpoint(prisma, runId, summary, batch.at(-1)!.yahooSymbol);
      }
    }
    const latest = allStocks.reduce<Date | null>((current, stock) => !current || stock.latestDate! > current ? stock.latestDate : current, null);
    const validation = { status: summary.attempted === summary.success + summary.noUpdate + summary.permanentUnavailable + summary.retryableFailure ? "PASS" : "FAIL", market: job.exchange, universe: allStocks.length, processed: summary.attempted, source: "YAHOO", summaryType: "DAILY_SUMMARY" };
    await completeLifecycleRun(prisma, runId, summary, latest, validation);
    return { jobId: job.id, runType, status: "COMPLETED", ...summary };
  } catch (error) {
    await failLifecycleRun(prisma, runId, error);
    throw error;
  } finally {
    await releaseLifecycleLock(prisma, job.id, owner);
  }
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const results: Record<string, unknown>[] = [];
  for (const job of config.jobs.filter((value) => !selectedJob || value.id === selectedJob)) {
    const now = clock(job.timezone);
    if (!job.weekdays.includes(now.weekday)) continue;
    const candidates: Array<[RunType, string]> = [["PRIMARY", job.primaryTime], ["RETRY", job.retryTime]];
    for (const [runType, time] of candidates) {
      const due = runAllDue ? now.time >= time : now.time === time;
      if (due && await lastSuccessDay(job.id, job.timezone, runType) !== now.day) results.push(await execute(job, runType));
    }
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
