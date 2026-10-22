import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  addOutcome,
  acquireLifecycleLock,
  completeLifecycleRun,
  createLifecycleRun,
  createSummary,
  failLifecycleRun,
  heartbeatLifecycleLock,
  loadLifecycleResumeCheckpoint,
  persistLifecycleCheckpoint,
  pauseLifecycleRun,
  recoverOrphanedLifecycleRun,
  releaseLifecycleLock,
} from "../production/run-lifecycle.ts";

type Stock = { id: string; ticker: string; yahooSymbol: string; latestDate: Date | null; historyBackfilledAt: Date | null };
type Candle = { date: Date; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null; adjClose: number | null };
type Mapping = { canonical_symbol: string; provider_symbol: string; availability: string; rule: string; reason: string; evidence: string | null };
type Member = { canonicalSymbol: string; stock: Stock | null; mapping: Mapping | null };

const rawDatabaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!rawDatabaseUrl) throw new Error("DATABASE_URL_REQUIRED");
const boundedDatabaseUrl = new URL(rawDatabaseUrl);
if (!boundedDatabaseUrl.searchParams.has("connection_limit")) boundedDatabaseUrl.searchParams.set("connection_limit", "1");
if (!boundedDatabaseUrl.searchParams.has("pool_timeout")) boundedDatabaseUrl.searchParams.set("pool_timeout", "20");
const prisma = new PrismaClient({ datasources: { db: { url: boundedDatabaseUrl.toString() } } });
const marketArg = process.argv.find((value) => value.startsWith("--market="))?.slice("--market=".length) ?? "SP500";
if (!["SP500", "NYSE"].includes(marketArg)) throw new Error(`UNSUPPORTED_HISTORICAL_MARKET:${marketArg}`);
const MARKET = marketArg as "SP500" | "NYSE";
const JOB_ID = MARKET === "SP500" ? "sp500-yahoo-historical" : "nyse-yahoo-historical";
const EXCHANGE = MARKET;
const CHECKPOINT_EVERY = 25;
const CONCURRENCY = 4;
const maxSymbolsArg = process.argv.find((value) => value.startsWith("--max-symbols="))?.slice("--max-symbols=".length);
const maxSymbols = maxSymbolsArg ? Number.parseInt(maxSymbolsArg, 10) : null;
const DAILY_JOB_ID = MARKET === "NYSE" ? "nyse-yahoo-daily" : "sp500-yahoo-daily";
const DRY_RUN = process.argv.includes("--dry-run");
const INSERT_CHUNK_SIZE = 1_000;

async function dailyIsActive(): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ active: boolean }>>(
    "SELECT EXISTS(SELECT 1 FROM production_scheduler_locks WHERE job_id=$1 AND expires_at>NOW() AND updated_at>NOW()-INTERVAL '10 minutes') AS active",
    DAILY_JOB_ID,
  );
  return Boolean(rows[0]?.active);
}

async function historicalPauseRequested(runId: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ status: string }>>("SELECT status FROM production_scheduler_runs WHERE id=$1", runId);
  return rows[0]?.status === "PAUSE_REQUESTED";
}

function csvTickers(contents: string): string[] {
  return [...new Set(contents.split(/\r?\n/).slice(1).map((line) => line.split(",")[0]?.trim()).filter((ticker): ticker is string => Boolean(ticker)))];
}

function yahooCandidates(ticker: string): string[] {
  return [...new Set([ticker, ticker.replaceAll(".", "-")])];
}

async function fetchMax(symbol: string): Promise<Candle[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=${Math.floor((Date.now() + 86_400_000) / 1000)}&interval=1d&events=history`, { headers: { "User-Agent": "Mozilla/5.0 (SmartFund Production Historical)" }, signal: controller.signal });
    if (!response.ok) throw new Error(`YAHOO_HTTP_${response.status}`);
    const payload = await response.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, Array<number | null>>>; adjclose?: Array<{ adjclose?: Array<number | null> }> } }> } };
    const result = payload.chart?.result?.[0];
    if (!result) return null;
    const quote = result.indicators?.quote?.[0] ?? {};
    const adjusted = result.indicators?.adjclose?.[0]?.adjclose ?? [];
    return (result.timestamp ?? []).map((timestamp, index) => ({ date: new Date(timestamp * 1000), open: quote.open?.[index] ?? null, high: quote.high?.[index] ?? null, low: quote.low?.[index] ?? null, close: quote.close?.[index] ?? null, volume: quote.volume?.[index] ?? null, adjClose: adjusted[index] ?? null }));
  } finally {
    clearTimeout(timeout);
  }
}

async function insertMissingYahooCandles(stock: Stock, candles: Candle[]): Promise<{ inserted: number; updated: number }> {
  const valid = candles.filter((candle) => candle.close !== null);
  const payload = valid.map((candle) => ({
    id: randomUUID(),
    date: candle.date.toISOString().slice(0, 10),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    adjustedClose: candle.adjClose,
    volume: candle.volume,
  }));
  let inserted = 0;
  for (let offset = 0; offset < payload.length; offset += INSERT_CHUNK_SIZE) {
    const chunk = payload.slice(offset, offset + INSERT_CHUNK_SIZE);
    inserted += await prisma.$executeRawUnsafe(
      `INSERT INTO stock_history (id, stock_id, date, open, high, low, close, adjusted_close, volume, source, source_symbol, provider_method, imported_at, updated_at)
       SELECT value->>'id', $1, (value->>'date')::date, NULLIF(value->>'open', '')::numeric, NULLIF(value->>'high', '')::numeric,
              NULLIF(value->>'low', '')::numeric, (value->>'close')::numeric, NULLIF(value->>'adjustedClose', '')::numeric,
              NULLIF(value->>'volume', '')::numeric, 'YAHOO', $2, 'YAHOO_CHART_API', NOW(), NOW()
       FROM jsonb_array_elements($3::jsonb) AS value
       ON CONFLICT (stock_id, date) DO NOTHING`,
      stock.id,
      stock.yahooSymbol,
      JSON.stringify(chunk),
    );
  }
  return { inserted, updated: 0 };
}

async function hasValidatedYahooHistorical(stock: Stock): Promise<boolean> {
  if (!stock.historyBackfilledAt) return false;
  const rows = await prisma.$queryRawUnsafe<Array<{ yahoo_exists: boolean }>>(
    "SELECT EXISTS(SELECT 1 FROM stock_history WHERE stock_id = $1 AND source = 'YAHOO' LIMIT 1) AS yahoo_exists",
    stock.id,
  );
  return Boolean(rows[0]?.yahoo_exists);
}

function classification(error: unknown): "PERMANENT_UNAVAILABLE" | "RETRYABLE_FAILURE" {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("YAHOO_NO_DATA") || message.includes("YAHOO_HTTP_404") || message.includes("YAHOO_HTTP_422") ? "PERMANENT_UNAVAILABLE" : "RETRYABLE_FAILURE";
}

async function persistFailure(stock: Stock, error: unknown): Promise<"PERMANENT_UNAVAILABLE" | "RETRYABLE_FAILURE"> {
  const kind = classification(error);
  const message = error instanceof Error ? error.message : String(error);
  await prisma.$executeRawUnsafe(
    "INSERT INTO production_scheduler_failures (job_id, stock_id, symbol, attempts, last_error, error_type, last_attempted_at, next_retry_at, classification, resolved, resolution_reason) VALUES ($1, $2, $3, 1, $4, $5, NOW(), CASE WHEN $6 = 'RETRYABLE_FAILURE' THEN NOW() + INTERVAL '15 minutes' ELSE NULL END, $6, $6 = 'PERMANENT_UNAVAILABLE', CASE WHEN $6 = 'PERMANENT_UNAVAILABLE' THEN $4 ELSE NULL END) ON CONFLICT (job_id, stock_id) DO UPDATE SET attempts = production_scheduler_failures.attempts + 1, last_error = EXCLUDED.last_error, error_type = EXCLUDED.error_type, classification = EXCLUDED.classification, resolved = EXCLUDED.resolved, resolution_reason = EXCLUDED.resolution_reason, last_attempted_at = NOW(), next_retry_at = EXCLUDED.next_retry_at",
    JOB_ID,
    stock.id,
    stock.yahooSymbol,
    message,
    message.includes("AbortError") ? "YAHOO_TIMEOUT" : "YAHOO_HTTP_ERROR",
    kind,
  );
  return kind;
}

type Quality = { duplicate_rows: null; invalid_ohlcv_rows: null; yahoo_covered_stocks: number; non_yahoo_rows: null; earliest_date: Date | null; latest_date: Date | null; evidence_status: "EVIDENCE_PENDING" };
async function validateHistoricalRows(stockIds: string[]): Promise<Quality> {
  const rows = await prisma.$queryRawUnsafe<Quality[]>(
    "SELECT NULL::int AS duplicate_rows, NULL::int AS invalid_ohlcv_rows, COUNT(*) FILTER (WHERE history_backfilled_at IS NOT NULL)::int AS yahoo_covered_stocks, NULL::int AS non_yahoo_rows, NULL::date AS earliest_date, MAX(latest_date) AS latest_date, 'EVIDENCE_PENDING'::text AS evidence_status FROM stocks WHERE id = ANY($1::text[])",
    stockIds,
  );
  return rows[0] ?? { duplicate_rows: null, invalid_ohlcv_rows: null, yahoo_covered_stocks: 0, non_yahoo_rows: null, earliest_date: null, latest_date: null, evidence_status: "EVIDENCE_PENDING" };
}

async function resolveUniverse(): Promise<Member[]> {
  if (MARKET === "NYSE") {
    const rows = await prisma.stock.findMany({
      where: { country: "US", exchange: "NYSE", isActive: true, yahooSymbol: { not: "" } },
      select: { id: true, ticker: true, yahooSymbol: true, latestDate: true, historyBackfilledAt: true },
    });
    return rows.map((stock) => ({ canonicalSymbol: stock.ticker, stock, mapping: null }));
  }
  const csv = await readFile(join(process.cwd(), "scripts", "sp500.csv"), "utf8");
  const tickers = csvTickers(csv);
  const mappings = await prisma.$queryRawUnsafe<Mapping[]>("SELECT canonical_symbol, provider_symbol, availability, rule, reason, evidence FROM provider_symbol_mappings WHERE market = 'SP500' AND provider = 'YAHOO'");
  const mappingByCanonical = new Map(mappings.map((mapping) => [mapping.canonical_symbol, mapping]));
  const candidates = tickers.flatMap((ticker) => [...yahooCandidates(ticker), mappingByCanonical.get(ticker)?.provider_symbol].filter((value): value is string => Boolean(value)));
  const rows = await prisma.stock.findMany({
    where: { country: "US", isActive: true, OR: [{ ticker: { in: candidates } }, { yahooSymbol: { in: candidates } }] },
    select: { id: true, ticker: true, yahooSymbol: true, latestDate: true, historyBackfilledAt: true },
  });
  const byCandidate = new Map<string, Stock>();
  for (const row of rows) for (const candidate of yahooCandidates(row.ticker).concat(row.yahooSymbol)) byCandidate.set(candidate, row);
  return tickers.map((canonicalSymbol) => {
    const mapping = mappingByCanonical.get(canonicalSymbol) ?? null;
    const candidatesForMember = [...yahooCandidates(canonicalSymbol), mapping?.provider_symbol].filter((value): value is string => Boolean(value));
    const stock = candidatesForMember.map((candidate) => byCandidate.get(candidate)).find((value): value is Stock => Boolean(value)) ?? null;
    return { canonicalSymbol, stock, mapping };
  });
}

async function main(): Promise<void> {
  const members = await resolveUniverse();
  const unavailable = members.filter((member) => !member.stock && member.mapping?.availability === "PERMANENT_UNAVAILABLE");
  const unresolved = members.filter((member) => !member.stock && !unavailable.includes(member));
  if (unresolved.length) throw new Error(`UNRESOLVED_SP500_MAPPING:${unresolved.map((member) => member.canonicalSymbol).join(",")}`);
  const stocks = members.flatMap((member) => member.stock ? [member.stock] : []).sort((a, b) => a.yahooSymbol.localeCompare(b.yahooSymbol));
  if (DRY_RUN) {
    const resume = await loadLifecycleResumeCheckpoint(prisma, JOB_ID);
    const resumeIndex = resume?.last_symbol ? stocks.findIndex((stock) => stock.yahooSymbol === resume.last_symbol) : -1;
    if (resume?.last_symbol && resumeIndex < 0) throw new Error(`RESUME_SYMBOL_NOT_IN_UNIVERSE:${resume.last_symbol}`);
    const pending = resume ? stocks.slice(resumeIndex + 1) : stocks;
    const selected = pending.slice(0, maxSymbols && maxSymbols > 0 ? maxSymbols : 5);
    const [locks, runs, dailyActive] = await Promise.all([
      prisma.$queryRawUnsafe<Array<{ count: number }>>(
        "SELECT COUNT(*)::int AS count FROM production_scheduler_locks WHERE job_id = ANY($1::text[]) AND expires_at > NOW()",
        [JOB_ID, DAILY_JOB_ID],
      ),
      prisma.$queryRawUnsafe<Array<{ count: number }>>(
        "SELECT COUNT(*)::int AS count FROM production_scheduler_runs WHERE job_id = ANY($1::text[]) AND status IN ('RUNNING','IN_PROGRESS','PAUSE_REQUESTED')",
        [JOB_ID, DAILY_JOB_ID],
      ),
      dailyIsActive(),
    ]);
    const activeLocks = Number(locks[0]?.count ?? 0);
    const activeRuns = Number(runs[0]?.count ?? 0);
    console.log(JSON.stringify({
      jobId: JOB_ID,
      status: activeLocks === 0 && activeRuns === 0 && !dailyActive ? "DRY_RUN_READY" : "DRY_RUN_BLOCKED_COLLISION",
      market: MARKET,
      checkpoint: resume ? { lastSymbol: resume.last_symbol, processed: resume.processed, succeeded: resume.succeeded, failed: resume.failed } : null,
      plannedCount: selected.length,
      plannedSymbols: selected.map((stock) => stock.yahooSymbol),
      activeLocks,
      activeRuns,
      dailyActive,
      insertMode: "INSERT_MISSING_ONLY",
      writesPerformed: false,
    }, null, 2));
    return;
  }
  const lifecycle = await prisma.$queryRawUnsafe<Array<{ historical_status: string }>>("SELECT historical_status FROM production_market_lifecycles WHERE market_id = $1", MARKET);
  if (["MARKET_COMPLETE", "HISTORICAL_READY_WITH_EXCEPTIONS"].includes(lifecycle[0]?.historical_status ?? "")) {
    console.log(JSON.stringify({ jobId: JOB_ID, status: "SKIPPED_COMPLETED" }));
    return;
  }
  const owner = `historical:${process.env.RAILWAY_DEPLOYMENT_ID ?? process.pid}`;
  if (await dailyIsActive()) {
    console.log(JSON.stringify({ jobId: JOB_ID, status: "PAUSED_DAILY_PRIORITY", checkpointPreserved: true }));
    return;
  }
  if (!await acquireLifecycleLock(prisma, JOB_ID, owner)) {
    console.log(JSON.stringify({ jobId: JOB_ID, status: "SKIPPED_LOCKED" }));
    return;
  }
  let runId = "";
  try {
    await recoverOrphanedLifecycleRun(prisma, JOB_ID);
    runId = await createLifecycleRun(prisma, JOB_ID, EXCHANGE, "HISTORICAL");
    const summary = createSummary();
    summary.permanentUnavailable = unavailable.length;
    summary.attempted = unavailable.length;
    const resume = await loadLifecycleResumeCheckpoint(prisma, JOB_ID);
    const resumeIndex = resume?.last_symbol ? stocks.findIndex((stock) => stock.yahooSymbol === resume.last_symbol) : -1;
    if (resume?.last_symbol && resumeIndex < 0) throw new Error(`RESUME_SYMBOL_NOT_IN_UNIVERSE:${resume.last_symbol}`);
    if (resume) Object.assign(summary, resume.details ?? { attempted: resume.processed, completed: resume.succeeded, failed: resume.failed });
    const pending = resume ? stocks.slice(resumeIndex + 1) : stocks;
    const selected = maxSymbols && maxSymbols > 0 ? pending.slice(0, maxSymbols) : pending;
    for (let offset = 0; offset < selected.length; offset += CONCURRENCY) {
      const batch = selected.slice(offset, offset + CONCURRENCY);
      const outcomes = await Promise.all(batch.map(async (stock) => {
        try {
          if (await hasValidatedYahooHistorical(stock)) {
            return { attempted: 1, completed: 1, noUpdate: 1 };
          }
          const candles = await fetchMax(stock.yahooSymbol);
          const valid = candles?.filter((candle) => candle.close !== null) ?? [];
          if (!valid.length) throw new Error("YAHOO_NO_DATA");
          const { inserted, updated } = await insertMissingYahooCandles(stock, valid);
          const latest = valid.at(-1)!;
          await prisma.stock.update({ where: { id: stock.id }, data: { latestDate: latest.date, latestClose: latest.close!, historyBackfilledAt: new Date() } });
          await prisma.$executeRawUnsafe("DELETE FROM production_scheduler_failures WHERE job_id = $1 AND stock_id = $2", JOB_ID, stock.id);
          return { attempted: 1, completed: 1, inserted, updated, success: 1 };
        } catch (error) {
          const kind = await persistFailure(stock, error);
          return { attempted: 1, failed: 1, permanentUnavailable: kind === "PERMANENT_UNAVAILABLE" ? 1 : 0, retryableFailure: kind === "RETRYABLE_FAILURE" ? 1 : 0 };
        }
      }));
      const attemptedBeforeBatch = summary.attempted;
      outcomes.forEach((outcome) => addOutcome(summary, outcome));
      if (Math.floor(attemptedBeforeBatch / CHECKPOINT_EVERY) < Math.floor(summary.attempted / CHECKPOINT_EVERY) || offset + batch.length === selected.length) {
        await persistLifecycleCheckpoint(prisma, runId, summary, batch.at(-1)!.yahooSymbol);
        await heartbeatLifecycleLock(prisma, JOB_ID, owner);
        if (await dailyIsActive() || await historicalPauseRequested(runId)) {
          await pauseLifecycleRun(prisma, runId);
          console.log(JSON.stringify({ runId, status: "PAUSED_DAILY_PRIORITY", processed: summary.attempted, lastSymbol: batch.at(-1)!.yahooSymbol }, null, 2));
          return;
        }
      }
    }
    if (selected.length < pending.length) {
      await pauseLifecycleRun(prisma, runId);
      console.log(JSON.stringify({ runId, status: "PAUSED", processed: summary.attempted, lastSymbol: selected.at(-1)?.yahooSymbol ?? null }, null, 2));
      return;
    }
    const retryable = await prisma.$queryRawUnsafe<{ count: number }[]>("SELECT COUNT(*)::int AS count FROM production_scheduler_failures WHERE job_id = $1 AND classification = 'RETRYABLE_FAILURE' AND resolved = FALSE", JOB_ID);
    const quality = await validateHistoricalRows(stocks.map((stock) => stock.id));
    const historicalCoverage = members.length === 0 ? 0 : quality.yahoo_covered_stocks / members.length;
    const classified = summary.completed + summary.failed;
    const processingPasses = summary.attempted === stocks.length
      && classified === stocks.length
      && historicalCoverage >= 0.98;
    const historicalState = !processingPasses
      ? "RETRY_REQUIRED"
      : "HISTORICAL_READY_WITH_EXCEPTIONS";
    const validation = {
      status: processingPasses ? "PASS_WITH_EVIDENCE_GAP" : "FAIL",
      market: EXCHANGE,
      universe: members.length,
      resolvedStocks: stocks.length,
      permanentUnavailable: unavailable.map((member) => ({ canonicalSymbol: member.canonicalSymbol, providerSymbol: member.mapping?.provider_symbol, rule: member.mapping?.rule, reason: member.mapping?.reason, evidence: member.mapping?.evidence })),
      processed: summary.attempted,
      completed: summary.completed,
      failed: summary.failed,
      retryableFailures: retryable[0]?.count ?? 0,
      historicalCoverage,
      historicalState,
      source: "YAHOO",
      duplicateRows: quality.duplicate_rows,
      invalidOhlcvRows: quality.invalid_ohlcv_rows,
      yahooCoveredStocks: quality.yahoo_covered_stocks,
      nonYahooRows: quality.non_yahoo_rows,
      rowLevelQualityEvidence: quality.evidence_status,
      earliestTradingDate: quality.earliest_date,
      latestTradingDate: quality.latest_date,
      latestCompletedSymbol: stocks.at(-1)?.yahooSymbol ?? null,
      summaryType: "HISTORICAL_SUMMARY",
    };
    await completeLifecycleRun(prisma, runId, summary, quality.latest_date, validation);
    await prisma.$executeRawUnsafe(
      "INSERT INTO production_market_lifecycles (market_id, exchange, historical_job_id, historical_status, historical_run_id, historical_completed_at, historical_summary, updated_at) VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'MARKET_COMPLETE' THEN NOW() ELSE NULL END, $6::jsonb, NOW()) ON CONFLICT (market_id) DO UPDATE SET historical_status = EXCLUDED.historical_status, historical_run_id = EXCLUDED.historical_run_id, historical_completed_at = EXCLUDED.historical_completed_at, historical_summary = EXCLUDED.historical_summary, updated_at = NOW()",
      MARKET,
      EXCHANGE,
      JOB_ID,
      historicalState,
      runId,
      JSON.stringify(validation),
    );
    console.log(JSON.stringify({ runId, status: historicalState, summary, validation }, null, 2));
  } catch (error) {
    if (runId) await failLifecycleRun(prisma, runId, error);
    throw error;
  } finally {
    await releaseLifecycleLock(prisma, JOB_ID, owner);
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
