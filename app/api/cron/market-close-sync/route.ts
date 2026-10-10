// Market-close-sync — SHADOW MODE ONLY. Confirms, per eligible closed market, what Yahoo Spark would
// write vs what etf_history/etfs already have — and logs the comparison. Writes NOTHING to
// etf_history, etf_performance, or etfs. The only writes anywhere in this route are the existing
// run-log/checkpoint tables via beginRun/finishRun/writeCheckpoint (lib/cloud-ingestion/runContext),
// reused unmodified.
//
// ETF-only, per task scope. No stock/fund handling here.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, hourBucketKey, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { loadExchangeCalendarRegistry, SUFFIX_TO_JOB_ID, NO_SUFFIX_EXCHANGE_FALLBACK, resolveJobForEtf, jobById } from "@/lib/market-close-sync/marketConfig";
import { findEligibleTradeDate, pickClosedCandle, localDateFromUnix } from "@/lib/market-close-sync/marketTime";
import { fetchSparkBatch, SPARK_MAX_SYMBOLS_PER_BATCH } from "@/lib/market-close-sync/sparkClient";
import { classify } from "@/lib/market-close-sync/shadowCompare";
import type { ShadowClassification } from "@/lib/market-close-sync/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "MARKET_CLOSE_SYNC_SHADOW";
const TIME_BUDGET_MS = 240_000;
const REQUEST_DELAY_MS = 300;
// How many calendar days on either side of the target date to pull from etf_history before picking
// the row whose LOCAL date (via the market's own timezone) actually matches — see
// DATE_CONVENTION_FINDING in the task report: etf_history.date for at least Taiwan-suffix rows is
// stored as a UTC instant equal to the LOCAL midnight of the trading day, so a naive UTC date
// comparison is off by one. ±2 days is generous slack for any timezone's offset.
const DB_DATE_WINDOW_DAYS = 2;

type Cursor = { lastDoneDate: string | null; cursorDate: string; etfId: string };

// Checkpoint encoding (single text field, same schema as every other cloud-ingestion job):
// "<lastFullyCompletedDate|->|<inProgressDate>|<inProgressEtfIdCursor>"
function parseCursor(lastSymbol: string | null): Cursor {
  if (!lastSymbol) return { lastDoneDate: null, cursorDate: "", etfId: "" };
  const [doneDate, cursorDate, etfId] = lastSymbol.split("|");
  return { lastDoneDate: doneDate === "-" ? null : doneDate, cursorDate: cursorDate ?? "", etfId: etfId ?? "" };
}
function encodeCursor(c: Cursor): string {
  return `${c.lastDoneDate ?? "-"}|${c.cursorDate}|${c.etfId}`;
}

type MarketStatus = "ELIGIBLE" | "NOT_ELIGIBLE" | "NOT_REACHED";

type MarketDetail = {
  jobId: string;
  status: MarketStatus;
  notEligibleReason?: "NOT_YET_CLOSED" | "ALREADY_DONE" | "NO_TRADING_DAY_IN_WINDOW";
  targetLocalDate: string | null;
  requested: number;
  classifications: Record<ShadowClassification, number>;
  sourceMissingSymbols: string[];
  noBarSymbols: string[];
  newSymbols: string[];
  changedSymbols: string[];
  doneForToday: boolean;
};

const emptyCounts = (): Record<ShadowClassification, number> => ({ NEW: 0, CHANGED: 0, SAME: 0, SOURCE_MISSING: 0, NO_BAR_FOR_TARGET_DATE: 0, DB_NEWER: 0 });

/** One-time, read-only pass over the whole active+data_source ETF universe to report how many
 * ETFs resolve to no market calendar at all — grouped by the thing that failed to resolve (a
 * recognized-but-uncovered suffix, or "no-suffix" for US tickers whose exchange fallback also
 * didn't match). Never silently drops this count; always reported in the response. */
async function computeUnmapped(registry: Awaited<ReturnType<typeof loadExchangeCalendarRegistry>>) {
  const rows = await prisma.$queryRawUnsafe<Array<{ data_source: string; exchange: string | null }>>(
    `SELECT data_source, exchange FROM etfs WHERE is_active = true AND data_source IS NOT NULL`,
  );
  const unmapped: Record<string, number> = {};
  let unmappedTotal = 0;
  for (const row of rows) {
    const resolution = resolveJobForEtf(registry, row.data_source, row.exchange);
    if (resolution) continue;
    const dot = row.data_source.lastIndexOf(".");
    const key = dot === -1 ? `no-suffix:${row.exchange ?? "UNKNOWN_EXCHANGE"}` : row.data_source.slice(dot);
    unmapped[key] = (unmapped[key] ?? 0) + 1;
    unmappedTotal++;
  }
  return { unmappedTotal, unmappedBySuffix: unmapped, universeTotal: rows.length };
}

/** Looks up, for a batch of ETF ids, the etf_history row (if any) whose LOCAL date — converted
 * through the market's own timezone, exactly like Spark candle dates — equals targetLocalDate.
 * Pulls a ±DB_DATE_WINDOW_DAYS window of raw rows per etf_id (cheap: at most a handful of rows each)
 * and does the actual date match in JS, so this is correct regardless of whatever UTC-offset
 * convention a given row happens to be stored under. */
async function lookupDbRowsForTargetDate(etfIds: string[], timezone: string, targetLocalDate: string): Promise<Map<string, { date: string; close: number }>> {
  if (etfIds.length === 0) return new Map();
  const windowStart = new Date(`${targetLocalDate}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - DB_DATE_WINDOW_DAYS);
  const windowEnd = new Date(`${targetLocalDate}T00:00:00Z`);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + DB_DATE_WINDOW_DAYS);
  const rows = await prisma.$queryRawUnsafe<Array<{ etf_id: string; date: Date; close: unknown }>>(
    `SELECT etf_id, date, close FROM etf_history
      WHERE etf_id = ANY($1) AND date BETWEEN $2 AND $3 AND close IS NOT NULL`,
    etfIds, windowStart, windowEnd,
  );
  const result = new Map<string, { date: string; close: number }>();
  for (const row of rows) {
    const localDate = localDateFromUnix(Math.floor(new Date(row.date).getTime() / 1000), timezone);
    if (localDate !== targetLocalDate) continue;
    result.set(row.etf_id, { date: localDate, close: Number(row.close) });
  }
  return result;
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const now = new Date();
  const registry = await loadExchangeCalendarRegistry();
  const { unmappedTotal, unmappedBySuffix, universeTotal } = await computeUnmapped(registry);

  const marketDetails: MarketDetail[] = [];
  let timeBudgetStop = false;
  let rateLimitStop = false;
  const runKey = hourBucketKey("market-close-sync");
  const { runId, skipped } = await beginRun({
    jobName: JOB,
    provider: "YAHOO_SPARK",
    runKey,
    universeCount: universeTotal,
    batchSize: SPARK_MAX_SYMBOLS_PER_BATCH,
    checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey, unmappedTotal, unmappedBySuffix });
  }

  const consideredJobIds = [...new Set([...Object.values(SUFFIX_TO_JOB_ID), ...Object.values(NO_SUFFIX_EXCHANGE_FALLBACK)])];
  const suffixesByJob = new Map<string, string[]>();
  for (const [suffix, jobId] of Object.entries(SUFFIX_TO_JOB_ID)) suffixesByJob.set(jobId, [...(suffixesByJob.get(jobId) ?? []), suffix]);
  const fallbackExchangesByJob = new Map<string, string[]>();
  for (const [exchange, jobId] of Object.entries(NO_SUFFIX_EXCHANGE_FALLBACK)) fallbackExchangesByJob.set(jobId, [...(fallbackExchangesByJob.get(jobId) ?? []), exchange]);

  for (const jobId of consideredJobIds) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    if (rateLimitStop) break;

    const job = jobById(registry, jobId);
    if (!job) continue;

    const checkpointKey = `market-close-sync:${jobId}`;
    const before = await readCheckpoint(checkpointKey);
    const savedCursor = parseCursor(before?.lastSymbol ?? null);

    const eligibility = findEligibleTradeDate(job, now, (d) => savedCursor.lastDoneDate != null && d <= savedCursor.lastDoneDate);
    if (!eligibility.eligible) {
      marketDetails.push({
        jobId, status: "NOT_ELIGIBLE", notEligibleReason: eligibility.reason, targetLocalDate: null,
        requested: 0, classifications: emptyCounts(), sourceMissingSymbols: [], noBarSymbols: [], newSymbols: [], changedSymbols: [], doneForToday: eligibility.reason === "ALREADY_DONE",
      });
      continue;
    }
    const { targetLocalDate } = eligibility;

    let cursor: Cursor = savedCursor.cursorDate === targetLocalDate
      ? savedCursor // resuming an in-progress date
      : { lastDoneDate: savedCursor.lastDoneDate, cursorDate: targetLocalDate, etfId: "" }; // new target date — fresh cursor within it

    const suffixPatterns = (suffixesByJob.get(jobId) ?? []).map((s) => `%${s}`);
    const fallbackExchanges = fallbackExchangesByJob.get(jobId) ?? [];

    const counts = emptyCounts();
    const sourceMissingSymbols: string[] = [];
    const noBarSymbols: string[] = [];
    const newSymbols: string[] = [];
    const changedSymbols: string[] = [];
    let requested = 0;
    let marketDone = false;
    let fetchFailedThisMarket = false;

    while (Date.now() - startedMs <= TIME_BUDGET_MS) {
      const candidates = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; exchange: string | null; data_source: string }>>(
        `SELECT id, code, exchange, data_source
           FROM etfs
          WHERE is_active = true AND data_source IS NOT NULL AND id > $1
            AND (data_source LIKE ANY($2) OR (data_source NOT LIKE '%.%' AND exchange = ANY($3)))
          ORDER BY id ASC LIMIT $4`,
        cursor.etfId, suffixPatterns, fallbackExchanges, SPARK_MAX_SYMBOLS_PER_BATCH,
      );
      if (candidates.length === 0) { marketDone = true; break; }

      await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
      const batch = await fetchSparkBatch(candidates.map((c) => c.data_source));
      if (batch.rateLimited) { rateLimitStop = true; break; }
      if (batch.error) {
        // Transient fetch failure (network/timeout) — NOT the same as "Spark had nothing for this
        // symbol". Do not classify anything from this batch, do not advance the cursor; stop this
        // market for this invocation and retry the same position next time, rather than silently
        // mislabeling every symbol in the batch as SOURCE_MISSING.
        fetchFailedThisMarket = true;
        break;
      }

      const bySymbol = new Map(batch.candles.map((c) => [c.symbol, c.points]));
      const dbRows = await lookupDbRowsForTargetDate(candidates.map((c) => c.id), job.timezone, targetLocalDate);

      for (const etf of candidates) {
        requested++;
        const sparkSymbolPresent = bySymbol.has(etf.data_source);
        const points = bySymbol.get(etf.data_source) ?? [];
        const picked = pickClosedCandle(points, job, targetLocalDate, now);
        const dbRow = dbRows.get(etf.id);
        const dbDate = dbRow?.date ?? null;
        const dbClose = dbRow?.close ?? null;
        const sparkDate = picked ? targetLocalDate : null;
        const sparkClose = picked?.close ?? null;
        const c = classify({ dbDate, dbClose, sparkSymbolPresent, sparkDate, sparkClose });
        counts[c]++;
        if (c === "SOURCE_MISSING" && sourceMissingSymbols.length < 20) sourceMissingSymbols.push(etf.data_source);
        if (c === "NO_BAR_FOR_TARGET_DATE" && noBarSymbols.length < 20) noBarSymbols.push(etf.data_source);
        if (c === "NEW" && newSymbols.length < 20) newSymbols.push(etf.data_source);
        if (c === "CHANGED" && changedSymbols.length < 20) changedSymbols.push(etf.data_source);
      }
      cursor = { lastDoneDate: savedCursor.lastDoneDate, cursorDate: targetLocalDate, etfId: candidates[candidates.length - 1].id };
      await writeCheckpoint(JOB, checkpointKey, runId, { lastSymbol: encodeCursor(cursor), processed: requested, succeeded: counts.SAME + counts.CHANGED + counts.NEW, failed: counts.SOURCE_MISSING + counts.NO_BAR_FOR_TARGET_DATE });
      if (candidates.length < SPARK_MAX_SYMBOLS_PER_BATCH) { marketDone = true; break; }
    }

    if (marketDone) {
      cursor = { lastDoneDate: targetLocalDate, cursorDate: "", etfId: "" };
      await writeCheckpoint(JOB, checkpointKey, runId, { lastSymbol: encodeCursor(cursor), processed: requested, succeeded: counts.SAME + counts.CHANGED + counts.NEW, failed: counts.SOURCE_MISSING + counts.NO_BAR_FOR_TARGET_DATE });
    }

    marketDetails.push({
      jobId, status: "ELIGIBLE", targetLocalDate, requested, classifications: counts,
      sourceMissingSymbols, noBarSymbols, newSymbols, changedSymbols, doneForToday: marketDone,
    });
    if (fetchFailedThisMarket) continue; // move on to the next market rather than aborting the run
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
  }

  // Task J, item 6: any considered job that never got a turn this invocation (loop broke on time
  // budget / rate limit before reaching it) is reported as NOT_REACHED, distinct from NOT_ELIGIBLE.
  const seenJobIds = new Set(marketDetails.map((m) => m.jobId));
  for (const jobId of consideredJobIds) {
    if (seenJobIds.has(jobId)) continue;
    marketDetails.push({
      jobId, status: "NOT_REACHED", targetLocalDate: null, requested: 0, classifications: emptyCounts(),
      sourceMissingSymbols: [], noBarSymbols: [], newSymbols: [], changedSymbols: [], doneForToday: false,
    });
  }

  const status = rateLimitStop ? "PARTIAL" : timeBudgetStop ? "PARTIAL" : "COMPLETED";
  const totalRequested = marketDetails.reduce((s, m) => s + m.requested, 0);
  const totalFailed = marketDetails.reduce((s, m) => s + m.classifications.SOURCE_MISSING + m.classifications.NO_BAR_FOR_TARGET_DATE, 0);
  await finishRun(runId, JOB, "YAHOO_SPARK", startedMs, {
    status,
    attempted: totalRequested,
    completed: totalRequested - totalFailed,
    inserted: 0, // shadow mode — never writes price rows
    updated: 0, // shadow mode — never writes price rows
    failed: totalFailed,
    retryableFailures: 0,
    checkpointAfter: null,
    details: { time_budget_stop: timeBudgetStop, rate_limit_stop: rateLimitStop, markets: marketDetails, unmapped_total: unmappedTotal, unmapped_by_suffix: unmappedBySuffix },
  });

  return Response.json({ ok: true, job: JOB, runId, status, timeBudgetStop, rateLimitStop, markets: marketDetails, unmappedTotal, unmappedBySuffix, universeTotal });
}
