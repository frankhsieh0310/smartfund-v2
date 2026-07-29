import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  releaseLifecycleLock,
} from "../production/run-lifecycle.ts";

type Stock = { id: string; ticker: string; yahooSymbol: string; latestDate: Date | null; historyBackfilledAt: Date | null };
type Candle = { date: Date; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null; adjClose: number | null };
type Mapping = { canonical_symbol: string; provider_symbol: string; availability: string; rule: string; reason: string; evidence: string | null };
type Member = { canonicalSymbol: string; stock: Stock | null; mapping: Mapping | null };

const prisma = new PrismaClient();
const JOB_ID = "sp500-yahoo-historical";
const EXCHANGE = "SP500";
const CHECKPOINT_EVERY = 25;
const CONCURRENCY = 4;
const maxSymbolsArg = process.argv.find((value) => value.startsWith("--max-symbols="))?.slice("--max-symbols=".length);
const maxSymbols = maxSymbolsArg ? Number.parseInt(maxSymbolsArg, 10) : null;

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

type Quality = { duplicate_rows: number; invalid_ohlcv_rows: number; yahoo_covered_stocks: number; earliest_date: Date | null; latest_date: Date | null };
async function validateHistoricalRows(stockIds: string[]): Promise<Quality> {
  const rows = await prisma.$queryRawUnsafe<Quality[]>(
    "WITH scoped AS (SELECT stock_id, date, open, high, low, close, source FROM stock_history WHERE stock_id = ANY($1::text[])) SELECT (SELECT COUNT(*)::int FROM (SELECT stock_id, date FROM scoped GROUP BY stock_id, date HAVING COUNT(*) > 1) duplicates) AS duplicate_rows, (SELECT COUNT(*)::int FROM scoped WHERE close IS NULL OR (high IS NOT NULL AND low IS NOT NULL AND high < low) OR (high IS NOT NULL AND open IS NOT NULL AND high < open) OR (high IS NOT NULL AND close IS NOT NULL AND high < close) OR (low IS NOT NULL AND open IS NOT NULL AND low > open) OR (low IS NOT NULL AND close IS NOT NULL AND low > close)) AS invalid_ohlcv_rows, (SELECT COUNT(DISTINCT stock_id)::int FROM scoped WHERE source = 'YAHOO') AS yahoo_covered_stocks, (SELECT MIN(date) FROM scoped) AS earliest_date, (SELECT MAX(date) FROM scoped) AS latest_date",
    stockIds,
  );
  return rows[0] ?? { duplicate_rows: 0, invalid_ohlcv_rows: 0, yahoo_covered_stocks: 0, earliest_date: null, latest_date: null };
}

async function resolveUniverse(): Promise<Member[]> {
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
  const owner = `historical:${process.env.RAILWAY_DEPLOYMENT_ID ?? process.pid}`;
  if (!await acquireLifecycleLock(prisma, JOB_ID, owner)) {
    console.log(JSON.stringify({ jobId: JOB_ID, status: "SKIPPED_LOCKED" }));
    return;
  }
  let runId = "";
  try {
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
          if (stock.historyBackfilledAt) {
            return { attempted: 1, completed: 1, noUpdate: 1 };
          }
          const candles = await fetchMax(stock.yahooSymbol);
          const valid = candles?.filter((candle) => candle.close !== null) ?? [];
          if (!valid.length) throw new Error("YAHOO_NO_DATA");
          let inserted = 0;
          let updated = 0;
          for (const candle of valid) {
            const existing = await prisma.stockHistory.findUnique({ where: { stockId_date: { stockId: stock.id, date: candle.date } }, select: { id: true } });
            await prisma.stockHistory.upsert({
              where: { stockId_date: { stockId: stock.id, date: candle.date } },
              create: { stockId: stock.id, date: candle.date, open: candle.open, high: candle.high, low: candle.low, close: candle.close!, adjustedClose: candle.adjClose, volume: candle.volume, source: "YAHOO", sourceSymbol: stock.yahooSymbol, providerMethod: "YAHOO_CHART_API", importedAt: new Date(), updatedAt: new Date() },
              update: { open: candle.open, high: candle.high, low: candle.low, close: candle.close!, adjustedClose: candle.adjClose, volume: candle.volume, source: "YAHOO", sourceSymbol: stock.yahooSymbol, providerMethod: "YAHOO_CHART_API", updatedAt: new Date() },
            });
            if (existing) updated++; else inserted++;
          }
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
      }
    }
    if (selected.length < pending.length) {
      await pauseLifecycleRun(prisma, runId);
      console.log(JSON.stringify({ runId, status: "PAUSED", processed: summary.attempted, lastSymbol: selected.at(-1)?.yahooSymbol ?? null }, null, 2));
      return;
    }
    const retryable = await prisma.$queryRawUnsafe<{ count: number }[]>("SELECT COUNT(*)::int AS count FROM production_scheduler_failures WHERE job_id = $1 AND classification = 'RETRYABLE_FAILURE' AND resolved = FALSE", JOB_ID);
    const quality = await validateHistoricalRows(stocks.map((stock) => stock.id));
    const validation = {
      status: summary.attempted === members.length && retryable[0]?.count === 0 && quality.duplicate_rows === 0 && quality.invalid_ohlcv_rows === 0 && quality.yahoo_covered_stocks === stocks.length ? "PASS" : "FAIL",
      market: EXCHANGE,
      universe: members.length,
      resolvedStocks: stocks.length,
      permanentUnavailable: unavailable.map((member) => ({ canonicalSymbol: member.canonicalSymbol, providerSymbol: member.mapping?.provider_symbol, rule: member.mapping?.rule, reason: member.mapping?.reason, evidence: member.mapping?.evidence })),
      processed: summary.attempted,
      completed: summary.completed,
      failed: summary.failed,
      retryableFailures: retryable[0]?.count ?? 0,
      source: "YAHOO",
      duplicateRows: quality.duplicate_rows,
      invalidOhlcvRows: quality.invalid_ohlcv_rows,
      yahooCoveredStocks: quality.yahoo_covered_stocks,
      earliestTradingDate: quality.earliest_date,
      latestTradingDate: quality.latest_date,
      latestCompletedSymbol: stocks.at(-1)?.yahooSymbol ?? null,
      summaryType: "HISTORICAL_SUMMARY",
    };
    await completeLifecycleRun(prisma, runId, summary, quality.latest_date, validation);
    await prisma.$executeRawUnsafe(
      "INSERT INTO production_market_lifecycles (market_id, exchange, historical_job_id, historical_status, historical_run_id, historical_completed_at, historical_summary, updated_at) VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'MARKET_COMPLETE' THEN NOW() ELSE NULL END, $6::jsonb, NOW()) ON CONFLICT (market_id) DO UPDATE SET historical_status = EXCLUDED.historical_status, historical_run_id = EXCLUDED.historical_run_id, historical_completed_at = EXCLUDED.historical_completed_at, historical_summary = EXCLUDED.historical_summary, updated_at = NOW()",
      "SP500",
      EXCHANGE,
      JOB_ID,
      validation.status === "PASS" ? "MARKET_COMPLETE" : "RETRY_REQUIRED",
      runId,
      JSON.stringify(validation),
    );
    console.log(JSON.stringify({ runId, status: validation.status === "PASS" ? "MARKET_COMPLETE" : "RETRY_REQUIRED", summary, validation }, null, 2));
  } catch (error) {
    if (runId) await failLifecycleRun(prisma, runId, error);
    throw error;
  } finally {
    await releaseLifecycleLock(prisma, JOB_ID, owner);
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
