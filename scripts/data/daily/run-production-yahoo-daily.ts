import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  addCalendarDays,
  dateKey,
  dispatchAt,
  latestClosedTradingDate,
  loadExchangeCalendarRegistry,
  marketClock,
  timezoneOffsetMinutes,
  utcDate,
  type ExchangeCalendarJob,
} from "./exchange-calendar.ts";
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
  type ResumeCheckpoint,
  type RunSummary,
} from "../production/run-lifecycle.ts";

type YahooCandle = {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  adjClose: number | null;
};

type YahooChart = {
  candles: YahooCandle[];
  currency: string | null;
  exchangeTimezone: string | null;
};

type RunType = "PRIMARY" | "RETRY";
type StockTask = { id: string; yahooSymbol: string; latestDate: Date | null };
type TaskOutcome = Pick<RunSummary, "completed" | "inserted" | "updated" | "failed" | "success" | "noUpdate" | "permanentUnavailable" | "retryableFailure" | "upToProviderLatest">;

class YahooRequestError extends Error {
  readonly httpStatus: number | null;

  constructor(message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "YahooRequestError";
    this.httpStatus = httpStatus;
  }
}

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const selectedJob = args.find((value) => value.startsWith("--job="))?.slice(6);
const selectedTargetDate = args.find((value) => value.startsWith("--target-date="))?.slice(14);
const selectedRunType = (args.find((value) => value.startsWith("--run-type="))?.slice(11) ?? "PRIMARY") as RunType;
const action = args.find((value) => value.startsWith("--action="))?.slice(9) ?? "dispatch";
const planOnly = args.includes("--plan");
const CONCURRENCY = 4;
const CHECKPOINT_EVERY = 25;
const REQUEST_DELAY_MS = 300;
const RETRY_BASE_MINUTES = 15;

function addOutcome(summary: RunSummary, outcome: TaskOutcome): void {
  summary.attempted += 1;
  summary.completed += outcome.completed;
  summary.inserted += outcome.inserted;
  summary.updated += outcome.updated;
  summary.failed += outcome.failed;
  summary.success += outcome.success;
  summary.noUpdate += outcome.noUpdate;
  summary.permanentUnavailable += outcome.permanentUnavailable;
  summary.retryableFailure += outcome.retryableFailure;
  summary.upToProviderLatest += outcome.upToProviderLatest;
}

function dayUnix(value: string): number {
  return Math.floor(utcDate(value).getTime() / 1000);
}

function candleKey(candle: YahooCandle, timezone: string): string {
  return dateKey(candle.date, timezone);
}

function validDailyCandle(candle: YahooCandle): boolean {
  return candle.open !== null && candle.high !== null && candle.low !== null && candle.close !== null
    && candle.adjClose !== null && candle.volume !== null
    && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0 && candle.adjClose > 0
    && candle.high >= candle.low && candle.volume >= 0;
}

function validateProviderMetadata(chart: YahooChart, job: ExchangeCalendarJob, targetTradeDate: string): void {
  if (!chart.currency) throw new YahooRequestError("CURRENCY_MISSING");
  if (!chart.exchangeTimezone) throw new YahooRequestError("TIMEZONE_MISSING");
  const reference = utcDate(targetTradeDate);
  if (timezoneOffsetMinutes(reference, chart.exchangeTimezone) !== timezoneOffsetMinutes(reference, job.timezone)) {
    throw new YahooRequestError(`TIMEZONE_MISMATCH:${chart.exchangeTimezone}:${job.timezone}`);
  }
}

async function fetchYahooChart(symbol: string, startDate: string, endDateExclusive: string): Promise<YahooChart> {
  if (!symbol.trim()) throw new YahooRequestError("MISSING_YAHOO_SYMBOL");
  await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${dayUnix(startDate)}&period2=${dayUnix(endDateExclusive)}&interval=1d&events=history`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (SmartFund Exchange Daily Production)" },
      signal: controller.signal,
    });
    if (!response.ok) throw new YahooRequestError(`YAHOO_CHART_HTTP_${response.status}`, response.status);
    const payload = await response.json() as {
      chart?: {
        result?: Array<{
          meta?: { currency?: string; exchangeTimezoneName?: string };
          timestamp?: number[];
          indicators?: {
            quote?: Array<Record<string, Array<number | null>>>;
            adjclose?: Array<{ adjclose?: Array<number | null> }>;
          };
        }>;
        error?: { code?: string; description?: string };
      };
    };
    const result = payload.chart?.result?.[0];
    if (!result) throw new YahooRequestError(`YAHOO_NO_DATA:${payload.chart?.error?.code ?? "EMPTY_RESULT"}`);
    const quote = result.indicators?.quote?.[0] ?? {};
    const adjusted = result.indicators?.adjclose?.[0]?.adjclose ?? [];
    return {
      currency: result.meta?.currency ?? null,
      exchangeTimezone: result.meta?.exchangeTimezoneName ?? null,
      candles: (result.timestamp ?? []).map((timestamp, index) => ({
        date: new Date(timestamp * 1000),
        open: quote.open?.[index] ?? null,
        high: quote.high?.[index] ?? null,
        low: quote.low?.[index] ?? null,
        close: quote.close?.[index] ?? null,
        volume: quote.volume?.[index] ?? null,
        adjClose: adjusted[index] ?? null,
      })),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new YahooRequestError("YAHOO_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function errorType(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("YAHOO_TIMEOUT")) return "YAHOO_TIMEOUT";
  if (message.includes("PROVIDER_NOT_READY") || message.includes("YAHOO_NO_TARGET_CANDLE")) return "PROVIDER_NOT_READY";
  if (message.includes("YAHOO_NO_DATA")) return "YAHOO_NO_DATA";
  if (message.includes("YAHOO_CHART_HTTP_")) return "YAHOO_HTTP_ERROR";
  if (message.includes("INVALID_OHLCV") || message.includes("TIMEZONE_MISMATCH") || message.includes("TIMEZONE_MISSING") || message.includes("CURRENCY_MISSING")) return "VALIDATION_ERROR";
  if (message.includes("Prisma") || message.includes("database")) return "DATABASE_ERROR";
  if (message.includes("MISSING_YAHOO_SYMBOL")) return "INVALID_SYMBOL";
  return "UNKNOWN_ERROR";
}

function httpStatus(error: unknown): number | null {
  return error instanceof YahooRequestError ? error.httpStatus : null;
}

async function providerReady(job: ExchangeCalendarJob, targetTradeDate: string): Promise<{ ready: boolean; providerLatestDate: string | null; reason: string | null }> {
  const latestDates: string[] = [];
  for (const symbol of job.providerProbeSymbols) {
    try {
      const chart = await fetchYahooChart(symbol, addCalendarDays(targetTradeDate, -10), addCalendarDays(targetTradeDate, 2));
      validateProviderMetadata(chart, job, targetTradeDate);
      const valid = chart.candles.filter(validDailyCandle);
      const latest = valid.at(-1);
      if (!latest) return { ready: false, providerLatestDate: null, reason: `PROBE_EMPTY:${symbol}` };
      const latestDate = candleKey(latest, job.timezone);
      latestDates.push(latestDate);
      const target = valid.find((candle) => candleKey(candle, job.timezone) === targetTradeDate);
      if (!target) return { ready: false, providerLatestDate: latestDate, reason: `PROBE_TARGET_MISSING:${symbol}` };
    } catch (error) {
      return { ready: false, providerLatestDate: latestDates.at(-1) ?? null, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const providerLatestDate = latestDates.sort().at(-1) ?? null;
  return { ready: latestDates.every((value) => value >= targetTradeDate), providerLatestDate, reason: null };
}

async function recordProviderProbe(job: ExchangeCalendarJob, targetTradeDate: string, probe: Awaited<ReturnType<typeof providerReady>>): Promise<void> {
  const runKey = `${job.id}:${targetTradeDate}:PROVIDER_PROBE`;
  const status = probe.ready ? "COMPLETED" : "PROVIDER_NOT_READY";
  await prisma.$executeRawUnsafe(
    "INSERT INTO production_scheduler_runs (id, job_id, exchange, run_type, status, started_at, completed_at, target_trade_date, expected_trading_date, provider_latest_date, run_key, validation_status, validation_details, exit_code, details, error) VALUES ($1,$2,$3,'PROVIDER_PROBE',$4,NOW(),NOW(),$5,$5,$6,$7,$8,$9::jsonb,0,$9::jsonb,$10) ON CONFLICT (run_key) WHERE run_key IS NOT NULL DO UPDATE SET status=EXCLUDED.status, completed_at=NOW(), provider_latest_date=EXCLUDED.provider_latest_date, validation_status=EXCLUDED.validation_status, validation_details=EXCLUDED.validation_details, exit_code=0, details=EXCLUDED.details, error=EXCLUDED.error",
    randomUUID(),
    job.id,
    job.market,
    status,
    utcDate(targetTradeDate),
    probe.providerLatestDate ? utcDate(probe.providerLatestDate) : null,
    runKey,
    probe.ready ? "PASS" : "WAITING",
    JSON.stringify({ targetTradeDate, ...probe }),
    probe.reason,
  );
}

async function completedForTarget(jobId: string, targetTradeDate: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ complete: boolean }>>(
    "SELECT EXISTS(SELECT 1 FROM production_scheduler_runs WHERE job_id=$1 AND run_type='PRIMARY' AND status='COMPLETED' AND exit_code=0 AND COALESCE(target_trade_date, latest_trading_date::date)=$2::date) AS complete",
    jobId,
    targetTradeDate,
  );
  return Boolean(rows[0]?.complete);
}

async function retryDue(jobId: string, targetTradeDate: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ due: boolean }>>(
    "SELECT EXISTS(SELECT 1 FROM production_scheduler_failures WHERE job_id=$1 AND target_trade_date=$2::date AND resolved=FALSE AND classification='RETRYABLE_FAILURE' AND COALESCE(next_retry_at,NOW())<=NOW()) AS due",
    jobId,
    targetTradeDate,
  );
  return Boolean(rows[0]?.due);
}

async function recordFailure(job: ExchangeCalendarJob, stock: StockTask, targetTradeDate: string, providerLatestDate: string | null, error: unknown): Promise<"PERMANENT_UNAVAILABLE" | "RETRYABLE_FAILURE"> {
  const existing = await prisma.$queryRawUnsafe<Array<{ attempts: number; first_failed_at: Date; resolved: boolean }>>(
    "SELECT attempts, first_failed_at, resolved FROM production_scheduler_failures WHERE job_id=$1 AND stock_id=$2",
    job.id,
    stock.id,
  );
  const prior = existing[0]?.resolved ? null : existing[0];
  const firstFailedAt = prior?.first_failed_at ?? new Date();
  const ageDays = Math.floor((Date.now() - firstFailedAt.getTime()) / 86_400_000);
  const attempts = (prior?.attempts ?? 0) + 1;
  const permanent = ageDays >= 30;
  const classification = permanent ? "PERMANENT_UNAVAILABLE" : "RETRYABLE_FAILURE";
  const retryDelay = Math.min(120, RETRY_BASE_MINUTES * Math.max(1, Math.min(attempts, 8)));
  const message = error instanceof Error ? error.message : String(error);
  const type = errorType(error);
  await prisma.$executeRawUnsafe(
    "INSERT INTO production_scheduler_failures (job_id,stock_id,symbol,attempts,last_error,error_type,first_failed_at,last_attempted_at,next_retry_at,classification,resolved,resolution_reason,target_trade_date,provider_latest_date,last_http_status) VALUES ($1,$2,$3,1,$4,$5,NOW(),NOW(),CASE WHEN $6='RETRYABLE_FAILURE' THEN NOW()+($7 || ' minutes')::interval ELSE NULL END,$6,$6='PERMANENT_UNAVAILABLE',CASE WHEN $6='PERMANENT_UNAVAILABLE' THEN $5 ELSE NULL END,$8,$9,$10) ON CONFLICT (job_id,stock_id) DO UPDATE SET symbol=EXCLUDED.symbol, attempts=CASE WHEN production_scheduler_failures.resolved THEN 1 ELSE production_scheduler_failures.attempts+1 END, last_error=EXCLUDED.last_error, error_type=EXCLUDED.error_type, first_failed_at=CASE WHEN production_scheduler_failures.resolved THEN NOW() ELSE production_scheduler_failures.first_failed_at END, last_attempted_at=NOW(), next_retry_at=EXCLUDED.next_retry_at, classification=EXCLUDED.classification, resolved=EXCLUDED.resolved, resolved_at=CASE WHEN EXCLUDED.resolved THEN NOW() ELSE NULL END, resolution_reason=EXCLUDED.resolution_reason, target_trade_date=EXCLUDED.target_trade_date, provider_latest_date=EXCLUDED.provider_latest_date, last_http_status=EXCLUDED.last_http_status",
    job.id,
    stock.id,
    stock.yahooSymbol,
    message,
    type,
    classification,
    String(retryDelay),
    utcDate(targetTradeDate),
    providerLatestDate ? utcDate(providerLatestDate) : null,
    httpStatus(error),
  );
  return classification;
}

async function loadResume(job: ExchangeCalendarJob, targetTradeDate: string, runType: RunType): Promise<ResumeCheckpoint | null> {
  const target = utcDate(targetTradeDate);
  const exact = await loadLifecycleResumeCheckpoint(prisma, job.id, { targetTradeDate: target, runType });
  if (exact || runType !== "PRIMARY") return exact;
  const legacy = await prisma.$queryRawUnsafe<Array<{ started_at: Date }>>(
    "SELECT r.started_at FROM production_scheduler_checkpoints c JOIN production_scheduler_runs r ON r.id=c.run_id WHERE c.job_id=$1 AND c.target_trade_date IS NULL AND r.status IN ('IN_PROGRESS','PAUSED','ABANDONED','STALE','FAILED') ORDER BY c.updated_at DESC LIMIT 1",
    job.id,
  );
  if (!legacy[0] || dateKey(legacy[0].started_at, job.timezone) !== targetTradeDate) return null;
  return loadLifecycleResumeCheckpoint(prisma, job.id);
}

async function stockTasks(job: ExchangeCalendarJob, runType: RunType, targetTradeDate: string): Promise<StockTask[]> {
  const failedIds = runType === "RETRY"
    ? (await prisma.$queryRawUnsafe<Array<{ stock_id: string }>>(
      "SELECT stock_id FROM production_scheduler_failures WHERE job_id=$1 AND target_trade_date=$2::date AND resolved=FALSE AND classification='RETRYABLE_FAILURE' AND COALESCE(next_retry_at,NOW())<=NOW() ORDER BY symbol",
      job.id,
      targetTradeDate,
    )).map((row) => row.stock_id)
    : null;
  return prisma.stock.findMany({
    where: {
      exchange: { in: job.exchanges },
      country: job.country,
      isActive: true,
      ...(failedIds ? { id: { in: failedIds } } : {}),
    },
    orderBy: { yahooSymbol: "asc" },
    select: { id: true, yahooSymbol: true, latestDate: true },
  });
}

async function processStock(job: ExchangeCalendarJob, stock: StockTask, targetTradeDate: string, providerLatestDate: string | null): Promise<TaskOutcome> {
  try {
    const chart = await fetchYahooChart(stock.yahooSymbol, addCalendarDays(targetTradeDate, -10), addCalendarDays(targetTradeDate, 2));
    validateProviderMetadata(chart, job, targetTradeDate);
    const providerLatest = chart.candles.filter(validDailyCandle).map((row) => candleKey(row, job.timezone)).sort().at(-1) ?? null;
    const candle = chart.candles.find((row) => candleKey(row, job.timezone) === targetTradeDate);
    if (!candle) throw new YahooRequestError(`YAHOO_NO_TARGET_CANDLE:${targetTradeDate}:${providerLatest ?? "NONE"}`);
    if (!validDailyCandle(candle)) throw new YahooRequestError(`INVALID_OHLCV:${targetTradeDate}`);
    const date = utcDate(targetTradeDate);
    const existing = await prisma.stockHistory.findUnique({
      where: { stockId_date: { stockId: stock.id, date } },
      select: { id: true, open: true, high: true, low: true, close: true, adjustedClose: true, volume: true },
    });
    const alreadyComplete = Boolean(existing?.open && existing.high && existing.low && existing.close && existing.adjustedClose && existing.volume !== null);
    await prisma.stockHistory.upsert({
      where: { stockId_date: { stockId: stock.id, date } },
      create: {
        stockId: stock.id, date, open: candle.open!, high: candle.high!, low: candle.low!, close: candle.close!,
        adjustedClose: candle.adjClose!, volume: candle.volume!, source: "YAHOO", sourceSymbol: stock.yahooSymbol,
        providerMethod: "YAHOO_CHART_API", importedAt: new Date(), updatedAt: new Date(),
      },
      update: {
        open: candle.open!, high: candle.high!, low: candle.low!, close: candle.close!, adjustedClose: candle.adjClose!,
        volume: candle.volume!, source: "YAHOO", sourceSymbol: stock.yahooSymbol,
        providerMethod: "YAHOO_CHART_API", updatedAt: new Date(),
      },
    });
    if (!stock.latestDate || stock.latestDate < date) {
      await prisma.stock.update({ where: { id: stock.id }, data: { latestDate: date, latestClose: candle.close! } });
    } else if (dateKey(stock.latestDate, "UTC") === targetTradeDate) {
      await prisma.stock.update({ where: { id: stock.id }, data: { latestClose: candle.close! } });
    }
    await prisma.$executeRawUnsafe(
      "UPDATE production_scheduler_failures SET resolved=TRUE,resolved_at=NOW(),resolution_reason='RETRY_RECOVERED',next_retry_at=NULL WHERE job_id=$1 AND stock_id=$2 AND resolved=FALSE",
      job.id,
      stock.id,
    );
    return {
      completed: 1,
      inserted: existing ? 0 : 1,
      updated: existing ? 1 : 0,
      failed: 0,
      success: alreadyComplete ? 0 : 1,
      noUpdate: alreadyComplete ? 1 : 0,
      permanentUnavailable: 0,
      retryableFailure: 0,
      upToProviderLatest: providerLatestDate === targetTradeDate ? 1 : 0,
    };
  } catch (error) {
    const classification = await recordFailure(job, stock, targetTradeDate, providerLatestDate, error);
    return {
      completed: 0, inserted: 0, updated: 0, failed: 1, success: 0, noUpdate: 0,
      permanentUnavailable: classification === "PERMANENT_UNAVAILABLE" ? 1 : 0,
      retryableFailure: classification === "RETRYABLE_FAILURE" ? 1 : 0,
      upToProviderLatest: 0,
    };
  }
}

async function pauseRequested(runId: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ status: string }>>("SELECT status FROM production_scheduler_runs WHERE id=$1", runId);
  return rows[0]?.status === "PAUSE_REQUESTED";
}

async function pauseConflictingHistorical(job: ExchangeCalendarJob): Promise<void> {
  const historicalJobId = job.id.replace(/-daily$/, "-historical");
  const requested = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    "UPDATE production_scheduler_runs SET status='PAUSE_REQUESTED', error='PAUSED_FOR_SAME_MARKET_DAILY' WHERE id=(SELECT id FROM production_scheduler_runs WHERE job_id=$1 AND status='IN_PROGRESS' ORDER BY started_at DESC LIMIT 1) RETURNING id",
    historicalJobId,
  );
  if (!requested[0]) return;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const locks = await prisma.$queryRawUnsafe<Array<{ active: boolean }>>(
      "SELECT EXISTS(SELECT 1 FROM production_scheduler_locks WHERE job_id=$1 AND expires_at>NOW() AND updated_at>NOW()-INTERVAL '10 minutes') AS active",
      historicalJobId,
    );
    if (!locks[0]?.active) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`HISTORICAL_PAUSE_TIMEOUT:${historicalJobId}`);
}

async function execute(job: ExchangeCalendarJob, targetTradeDate: string, runType: RunType, providerLatestDate: string | null): Promise<Record<string, unknown>> {
  const owner = `${process.env.RAILWAY_DEPLOYMENT_ID ?? process.env.HOSTNAME ?? "worker"}:${process.pid}:${randomUUID()}`;
  if (!await acquireLifecycleLock(prisma, job.id, owner)) return { jobId: job.id, targetTradeDate, runType, status: "SKIPPED_LOCKED" };
  let runId = "";
  try {
    await recoverOrphanedLifecycleRun(prisma, job.id);
    await pauseConflictingHistorical(job);
    const universe = await prisma.stock.count({ where: { exchange: { in: job.exchanges }, country: job.country, isActive: true } });
    const target = utcDate(targetTradeDate);
    const runKey = `${job.id}:${targetTradeDate}:${runType}`;
    runId = await createLifecycleRun(prisma, job.id, job.market, runType, {
      targetTradeDate: target,
      expectedTradingDate: target,
      providerLatestDate: providerLatestDate ? utcDate(providerLatestDate) : undefined,
      runKey,
      universeCount: universe,
    });
    const summary = createSummary();
    const all = await stockTasks(job, runType, targetTradeDate);
    const resume = await loadResume(job, targetTradeDate, runType);
    const resumeIndex = resume?.last_symbol ? all.findIndex((stock) => stock.yahooSymbol === resume.last_symbol) : -1;
    if (resume?.last_symbol && resumeIndex < 0) throw new Error(`RESUME_SYMBOL_NOT_IN_UNIVERSE:${resume.last_symbol}`);
    if (resume) {
      Object.assign(summary, resume.details ?? { attempted: resume.processed, completed: resume.succeeded, failed: resume.failed });
      await persistLifecycleCheckpoint(prisma, runId, summary, resume.last_symbol ?? "", { jobId: job.id, targetTradeDate: target, runType });
    }
    const tasks = resume ? all.slice(resumeIndex + 1) : all;
    let lastSymbol = resume?.last_symbol ?? "";
    for (let offset = 0; offset < tasks.length; offset += CONCURRENCY) {
      const batch = tasks.slice(offset, offset + CONCURRENCY);
      const attemptedBeforeBatch = summary.attempted;
      const outcomes = await Promise.all(batch.map((stock) => processStock(job, stock, targetTradeDate, providerLatestDate)));
      outcomes.forEach((outcome) => addOutcome(summary, outcome));
      lastSymbol = batch.at(-1)?.yahooSymbol ?? lastSymbol;
      if (Math.floor(attemptedBeforeBatch / CHECKPOINT_EVERY) < Math.floor(summary.attempted / CHECKPOINT_EVERY) || offset + batch.length === tasks.length) {
        if (lastSymbol) await persistLifecycleCheckpoint(prisma, runId, summary, lastSymbol, { jobId: job.id, targetTradeDate: target, runType });
        await heartbeatLifecycleLock(prisma, job.id, owner);
        if (await pauseRequested(runId)) {
          await pauseLifecycleRun(prisma, runId);
          return { jobId: job.id, targetTradeDate, runType, status: "PAUSED", checkpoint: lastSymbol, ...summary };
        }
      }
    }
    const db = await prisma.$queryRawUnsafe<Array<{ database_latest_date: Date | null; target_count: number }>>(
      "SELECT MAX(latest_date) AS database_latest_date, COUNT(*) FILTER (WHERE latest_date=$3::date)::int AS target_count FROM stocks WHERE exchange=ANY($1::text[]) AND country=$2 AND is_active=TRUE",
      job.exchanges,
      job.country,
      targetTradeDate,
    );
    const classified = summary.success + summary.noUpdate + summary.permanentUnavailable + summary.retryableFailure;
    const expectedAttempted = runType === "PRIMARY" ? universe : all.length;
    const validation = {
      status: summary.attempted === expectedAttempted && summary.attempted === classified ? "PASS" : "FAIL",
      market: job.market,
      targetTradeDate,
      expectedTradingDate: targetTradeDate,
      providerLatestDate,
      databaseLatestDate: db[0]?.database_latest_date?.toISOString().slice(0, 10) ?? null,
      universe,
      attempted: summary.attempted,
      completed: summary.completed,
      failed: summary.failed,
      noData: summary.permanentUnavailable,
      stale: summary.retryableFailure,
      retryRecovered: runType === "RETRY" ? summary.completed : 0,
      databaseTargetCount: db[0]?.target_count ?? 0,
      source: "YAHOO",
      summaryType: "DAILY_SUMMARY",
    };
    await completeLifecycleRun(prisma, runId, summary, target, validation);
    return { jobId: job.id, targetTradeDate, runType, status: validation.status === "PASS" ? "COMPLETED" : "FAILED", checkpoint: lastSymbol || null, validation, ...summary };
  } catch (error) {
    if (runId) await failLifecycleRun(prisma, runId, error);
    throw error;
  } finally {
    await releaseLifecycleLock(prisma, job.id, owner);
  }
}

async function requestPause(jobId: string): Promise<Record<string, unknown>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    "UPDATE production_scheduler_runs SET status='PAUSE_REQUESTED', error='OPERATOR_PAUSE_REQUESTED' WHERE id=(SELECT id FROM production_scheduler_runs WHERE job_id=$1 AND status='IN_PROGRESS' ORDER BY started_at DESC LIMIT 1) RETURNING id",
    jobId,
  );
  return { jobId, status: rows[0] ? "PAUSE_REQUESTED" : "NO_ACTIVE_RUN", runId: rows[0]?.id ?? null };
}

async function cancelStale(jobId: string): Promise<Record<string, unknown>> {
  const staleRuns = await recoverOrphanedLifecycleRun(prisma, jobId);
  const staleLocks = await prisma.$executeRawUnsafe("DELETE FROM production_scheduler_locks WHERE job_id=$1 AND (expires_at<NOW() OR updated_at<NOW()-INTERVAL '10 minutes')", jobId);
  return { jobId, status: "STALE_CLEANUP", staleRuns, staleLocks };
}

async function cleanupStaleConfiguredJobs(jobIds: string[]): Promise<{ staleRuns: number; staleLocks: number }> {
  const staleRuns = await prisma.$executeRawUnsafe(
    "UPDATE production_scheduler_runs r SET status='STALE',completed_at=NOW(),exit_code=1,error=COALESCE(error,'STALE_LOCK_CLEANUP') WHERE r.job_id=ANY($1::text[]) AND r.status='IN_PROGRESS' AND r.started_at<NOW()-INTERVAL '10 minutes' AND NOT EXISTS (SELECT 1 FROM production_scheduler_locks l WHERE l.job_id=r.job_id AND l.expires_at>NOW() AND l.updated_at>NOW()-INTERVAL '10 minutes')",
    jobIds,
  );
  const staleLocks = await prisma.$executeRawUnsafe(
    "DELETE FROM production_scheduler_locks WHERE job_id=ANY($1::text[]) AND (expires_at<NOW() OR updated_at<NOW()-INTERVAL '10 minutes')",
    jobIds,
  );
  return { staleRuns, staleLocks };
}

async function verifyLatestTradeDate(job: ExchangeCalendarJob, targetTradeDate: string): Promise<Record<string, unknown>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ universe: number; master_target: number; valid_target: number; database_latest_date: Date | null }>>(
    `SELECT COUNT(DISTINCT s.id)::int AS universe,
      COUNT(DISTINCT s.id) FILTER (WHERE s.latest_date=$3::date)::int AS master_target,
      COUNT(DISTINCT s.id) FILTER (WHERE h.date=$3::date AND h.open>0 AND h.high>=h.low AND h.low>0 AND h.close>0 AND h.adjusted_close>0 AND h.volume>=0 AND h.source='YAHOO')::int AS valid_target,
      MAX(s.latest_date) AS database_latest_date
     FROM stocks s LEFT JOIN stock_history h ON h.stock_id=s.id AND h.date=$3::date
     WHERE s.exchange=ANY($1::text[]) AND s.country=$2 AND s.is_active=TRUE`,
    job.exchanges,
    job.country,
    targetTradeDate,
  );
  const row = rows[0];
  return {
    jobId: job.id,
    status: row && row.universe === row.master_target && row.universe === row.valid_target ? "PASS" : "FAIL",
    targetTradeDate,
    ...row,
  };
}

async function rebuildCheckpoint(job: ExchangeCalendarJob, targetTradeDate: string, runType: RunType): Promise<Record<string, unknown>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; attempted: number; completed: number; inserted: number; updated: number; failed: number; success_count: number; no_update_count: number; permanent_unavailable_count: number; retryable_failure_count: number; details: Record<string, unknown> | null }>>(
    "SELECT id,attempted,completed,inserted,updated,failed,success_count,no_update_count,permanent_unavailable_count,retryable_failure_count,details FROM production_scheduler_runs WHERE job_id=$1 AND run_type=$2 AND COALESCE(target_trade_date,latest_trading_date::date)=$3::date AND status IN ('IN_PROGRESS','PAUSED','PAUSE_REQUESTED','STALE','FAILED') ORDER BY started_at DESC LIMIT 1",
    job.id,
    runType,
    targetTradeDate,
  );
  const run = rows[0];
  const currentSymbol = typeof run?.details?.currentSymbol === "string" ? run.details.currentSymbol : null;
  if (!run || !currentSymbol) throw new Error(`CHECKPOINT_REBUILD_SOURCE_MISSING:${job.id}:${targetTradeDate}:${runType}`);
  const summary: RunSummary = {
    attempted: run.attempted,
    completed: run.completed,
    inserted: run.inserted,
    updated: run.updated,
    failed: run.failed,
    success: run.success_count || Number(run.details?.success ?? 0),
    noUpdate: run.no_update_count || Number(run.details?.noUpdate ?? 0),
    permanentUnavailable: run.permanent_unavailable_count || Number(run.details?.permanentUnavailable ?? 0),
    retryableFailure: run.retryable_failure_count || Number(run.details?.retryableFailure ?? 0),
    upToProviderLatest: Number(run.details?.upToProviderLatest ?? 0),
  };
  await persistLifecycleCheckpoint(prisma, run.id, summary, currentSymbol, { jobId: job.id, targetTradeDate: utcDate(targetTradeDate), runType });
  return { jobId: job.id, status: "CHECKPOINT_REBUILT", targetTradeDate, runType, currentSymbol, processed: summary.attempted };
}

async function dispatcher(): Promise<void> {
  const registry = await loadExchangeCalendarRegistry();
  const now = new Date();
  if (marketClock("UTC", now).date > registry.calendarValidThrough) throw new Error(`CALENDAR_SYNC_REQUIRED:${registry.calendarValidThrough}`);
  const jobs = registry.jobs.filter((job) => job.schedulerEnabled && (!selectedJob || job.id === selectedJob));
  if (selectedJob && jobs.length !== 1) throw new Error(`UNKNOWN_JOB:${selectedJob}`);
  if (["pause", "cancel-stale", "verify", "rebuild-checkpoint", "resume", "retry"].includes(action) && !selectedJob) {
    throw new Error(`ACTION_REQUIRES_JOB:${action}`);
  }
  if (action === "pause") {
    console.log(JSON.stringify(await requestPause(jobs[0].id), null, 2));
    return;
  }
  if (action === "cancel-stale") {
    console.log(JSON.stringify(await cancelStale(jobs[0].id), null, 2));
    return;
  }
  if (action === "verify") {
    const targetTradeDate = selectedTargetDate ?? latestClosedTradingDate(jobs[0], now);
    console.log(JSON.stringify(await verifyLatestTradeDate(jobs[0], targetTradeDate), null, 2));
    return;
  }
  if (action === "rebuild-checkpoint") {
    const targetTradeDate = selectedTargetDate ?? latestClosedTradingDate(jobs[0], now);
    console.log(JSON.stringify(await rebuildCheckpoint(jobs[0], targetTradeDate, selectedRunType), null, 2));
    return;
  }

  const staleCleanup = planOnly ? { staleRuns: 0, staleLocks: 0 } : await cleanupStaleConfiguredJobs(registry.jobs.map((job) => job.id));

  const decisions: Array<{ job: ExchangeCalendarJob; targetTradeDate: string; dueAt: Date; runType: RunType; reason: string }> = [];
  const skipped: Record<string, unknown>[] = [];
  for (const job of jobs) {
    const targetTradeDate = selectedTargetDate ?? latestClosedTradingDate(job, now);
    const dueAt = dispatchAt(job, targetTradeDate);
    if (!selectedJob && dueAt > now) {
      skipped.push({ jobId: job.id, status: "SCHEDULED", targetTradeDate, dueAt: dueAt.toISOString() });
      continue;
    }
    const completed = await completedForTarget(job.id, targetTradeDate);
    if (completed && !(selectedJob && action === "retry")) {
      if (await retryDue(job.id, targetTradeDate)) decisions.push({ job, targetTradeDate, dueAt, runType: "RETRY", reason: "FAILURE_RETRY_DUE" });
      else skipped.push({ jobId: job.id, status: "SKIPPED_COMPLETED", targetTradeDate });
      continue;
    }
    decisions.push({ job, targetTradeDate, dueAt, runType: selectedJob ? (action === "retry" ? "RETRY" : selectedRunType) : "PRIMARY", reason: action === "resume" ? "OPERATOR_RESUME" : "MARKET_CLOSE_DUE" });
  }
  decisions.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  if (planOnly) {
    console.log(JSON.stringify({ at: now.toISOString(), mode: "PLAN", decisions, skipped, staleCleanup }, null, 2));
    return;
  }

  const active = await prisma.$queryRawUnsafe<Array<{ job_id: string }>>(
    "SELECT job_id FROM production_scheduler_locks WHERE expires_at>NOW() AND updated_at>NOW()-INTERVAL '10 minutes' AND job_id=ANY($1::text[])",
    registry.jobs.map((job) => job.id),
  );
  const maxConcurrent = registry.maxConcurrentMarketJobs ?? 3;
  const available = Math.max(0, maxConcurrent - active.length);
  const maxNew = selectedJob ? 1 : Math.min(registry.maxNewMarketJobsPerDispatch ?? 1, available);
  const activeIds = new Set(active.map((row) => row.job_id));
  const selected = decisions.filter((decision) => !activeIds.has(decision.job.id)).slice(0, maxNew);
  for (const decision of decisions) {
    if (activeIds.has(decision.job.id)) skipped.push({ jobId: decision.job.id, status: "RUNNING", targetTradeDate: decision.targetTradeDate });
    else if (!selected.includes(decision)) skipped.push({ jobId: decision.job.id, status: "QUEUED", targetTradeDate: decision.targetTradeDate });
  }
  const results: Record<string, unknown>[] = [];
  for (const decision of selected) {
    const probe = await providerReady(decision.job, decision.targetTradeDate);
    await recordProviderProbe(decision.job, decision.targetTradeDate, probe);
    if (!probe.ready) {
      results.push({ jobId: decision.job.id, targetTradeDate: decision.targetTradeDate, status: "PROVIDER_NOT_READY", providerLatestDate: probe.providerLatestDate, reason: probe.reason });
      continue;
    }
    try {
      results.push(await execute(decision.job, decision.targetTradeDate, decision.runType, probe.providerLatestDate));
    } catch (error) {
      results.push({ jobId: decision.job.id, targetTradeDate: decision.targetTradeDate, status: "FAILED", error: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), active: [...activeIds], results, skipped, staleCleanup }, null, 2));
}

dispatcher()
  .catch((error: unknown) => { console.error(error); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
