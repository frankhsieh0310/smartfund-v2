// Market-close-sync — SHADOW MODE ONLY. Confirms, per eligible closed market, what Yahoo Spark would
// write vs what etf_history/etfs already have — and logs the comparison. Writes NOTHING to
// etf_history, etf_performance, or etfs. The only writes anywhere in this route are the existing
// run-log/checkpoint tables via beginRun/finishRun/writeCheckpoint (lib/cloud-ingestion/runContext),
// reused unmodified.
//
// ETF-only, per task scope. No stock/fund handling here.
//
// Task K: a market is now only reported doneForToday once lib/market-close-sync/completionState.ts's
// isMarketDone() says every candidate ETF reached a genuinely FINAL state — not merely "the forward
// cursor ran out of rows to query once." See that module for the full rationale (Task I's real run
// wrongly stamped TWSE/Japan/HK as ALREADY_DONE after exactly one pass).

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, hourBucketKey, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { loadExchangeCalendarRegistry, SUFFIX_TO_JOB_ID, NO_SUFFIX_EXCHANGE_FALLBACK, resolveJobForEtf, jobById } from "@/lib/market-close-sync/marketConfig";
import { findEligibleTradeDate, pickClosedCandle } from "@/lib/market-close-sync/marketTime";
import { fetchSparkBatch, SPARK_MAX_SYMBOLS_PER_BATCH } from "@/lib/market-close-sync/sparkClient";
import { classify } from "@/lib/market-close-sync/shadowCompare";
import { emptyState, advanceSweep, isMarketDone, type MarketCompletionState } from "@/lib/market-close-sync/completionState";
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

// Checkpoint payload (JSON text in production_scheduler_checkpoints.last_symbol — that column has
// always been free-form text, so this is not a schema change). v1 was the old pipe-delimited
// "<lastDoneDate|->|<cursorDate>|<etfId>" scheme from tasks G–J; parsePersistedState treats anything
// that doesn't parse as v2 JSON as "no prior state", which is exactly what Task K's explicit
// checkpoint-clear step produces anyway.
type PersistedState = { v: 2; lastDoneDate: string | null; inProgress: MarketCompletionState | null };

function parsePersistedState(raw: string | null): PersistedState {
  if (!raw) return { v: 2, lastDoneDate: null, inProgress: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === 2) return parsed as PersistedState;
  } catch {
    // old v1 text or garbage — treated as a fresh start, same as an explicit checkpoint clear.
  }
  return { v: 2, lastDoneDate: null, inProgress: null };
}

type MarketStatus = "ELIGIBLE" | "NOT_ELIGIBLE" | "NOT_REACHED";

type MarketDetail = {
  jobId: string;
  status: MarketStatus;
  notEligibleReason?: "NOT_YET_CLOSED" | "ALREADY_DONE" | "NO_TRADING_DAY_IN_WINDOW";
  targetLocalDate: string | null;
  requested: number;
  classifications: Record<ShadowClassification, number>;
  fetchErrorCount: number;
  pendingCount: number; // ETFs still awaiting a confirmation pass (SOURCE_MISSING/NO_BAR) — 0 once doneForToday
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

/** Looks up, for a batch of ETF ids, the etf_history row (if any) whose stored calendar date equals
 * targetLocalDate.
 *
 * Task K correction: etf_history.date is a plain SQL DATE (no time component at all — confirmed
 * this round via a read-only 60-day time-of-day-distribution scan across every suffix in the
 * universe: 100% report "00:00", meaning the column carries no embedded UTC-offset skew whatsoever).
 * It is written as, and must be read as, the market's own local trading day directly — comparing its
 * ISO calendar-date substring against targetLocalDate needs no timezone math at all.
 *
 * Task J's original fix (superseded here) additionally ran this already-correct calendar date
 * through localDateFromUnix(ts, job.timezone) — appropriate for a true UTC instant (which is what
 * etfs.price_updated_at actually is, the field Task J was replacing), but wrong for a timezone-naive
 * DATE: re-projecting a date with no time-of-day through an IANA zone silently SHIFTS it by one day
 * for any market with a negative UTC offset. Confirmed live this round for both the US (no-suffix)
 * and Mexico (.MX): a stored row dated 2026-10-09 re-projected through America/New_York or
 * America/Mexico_City came back as 2026-10-08 — exactly the kind of off-by-one that made NYSE's
 * Task J shadow run report 633/640 ETFs as NEW (DB row genuinely present, just never matched). Pulls
 * a ±DB_DATE_WINDOW_DAYS window of raw rows per etf_id purely so a close call near midnight UTC in
 * whatever client/DB session timezone parses the Date object is still caught; the actual match below
 * is a plain string comparison, never a timezone conversion. */
async function lookupDbRowsForTargetDate(etfIds: string[], targetLocalDate: string): Promise<Map<string, { date: string; close: number }>> {
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
    const storedCalendarDate = new Date(row.date).toISOString().slice(0, 10);
    if (storedCalendarDate !== targetLocalDate) continue;
    result.set(row.etf_id, { date: storedCalendarDate, close: Number(row.close) });
  }
  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const persisted = parsePersistedState(before?.lastSymbol ?? null);
    const lastDoneDate = persisted.lastDoneDate;

    const eligibility = findEligibleTradeDate(job, now, (d) => lastDoneDate != null && d <= lastDoneDate);
    if (!eligibility.eligible) {
      marketDetails.push({
        jobId, status: "NOT_ELIGIBLE", notEligibleReason: eligibility.reason, targetLocalDate: null,
        requested: 0, classifications: emptyCounts(), fetchErrorCount: 0, pendingCount: 0,
        sourceMissingSymbols: [], noBarSymbols: [], newSymbols: [], changedSymbols: [], doneForToday: eligibility.reason === "ALREADY_DONE",
      });
      continue;
    }
    const { targetLocalDate } = eligibility;

    // Resume in-progress state for THIS target date, or start a fresh sweep if the persisted
    // in-progress state belongs to a different (now-superseded) date.
    let state: MarketCompletionState = persisted.inProgress && persisted.inProgress.targetLocalDate === targetLocalDate
      ? persisted.inProgress
      : emptyState(targetLocalDate);

    const suffixPatterns = (suffixesByJob.get(jobId) ?? []).map((s) => `%${s}`);
    const fallbackExchanges = fallbackExchangesByJob.get(jobId) ?? [];

    const counts = emptyCounts();
    const sourceMissingSymbols: string[] = [];
    const noBarSymbols: string[] = [];
    const newSymbols: string[] = [];
    const changedSymbols: string[] = [];
    let requested = 0;
    let fetchErrorCount = 0;
    let fetchFailedThisMarket = false;

    // Phase 1: forward sweep over the full candidate universe, resuming from state.cursorEtfId.
    // Already complete (sweepComplete=true) on resume means this loop body never runs — we go
    // straight to Phase 2 and only re-check whatever is still pending.
    while (!state.sweepComplete && Date.now() - startedMs <= TIME_BUDGET_MS) {
      const candidates = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; exchange: string | null; data_source: string }>>(
        `SELECT id, code, exchange, data_source
           FROM etfs
          WHERE is_active = true AND data_source IS NOT NULL AND id > $1
            AND (data_source LIKE ANY($2) OR (data_source NOT LIKE '%.%' AND exchange = ANY($3)))
          ORDER BY id ASC LIMIT $4`,
        state.cursorEtfId, suffixPatterns, fallbackExchanges, SPARK_MAX_SYMBOLS_PER_BATCH,
      );
      if (candidates.length === 0) {
        state = advanceSweep(state, { ok: true, isLastBatch: true, observations: [] }, Date.now());
        break;
      }

      await sleep(REQUEST_DELAY_MS);
      const batch = await fetchSparkBatch(candidates.map((c) => c.data_source));
      if (batch.rateLimited) { rateLimitStop = true; break; }
      if (batch.error) {
        // Transient fetch failure (network/timeout) — NOT the same as "Spark had nothing for this
        // symbol". classify() is never called for this batch; advanceSweep(..., {ok:false}) is a
        // strict no-op, so sweepComplete and the cursor are left exactly as they were and this same
        // batch is retried from scratch next invocation, rather than silently either mislabeling it
        // SOURCE_MISSING or (worse) letting the market be marked done around the gap.
        fetchErrorCount += candidates.length;
        fetchFailedThisMarket = true;
        state = advanceSweep(state, { ok: false }, Date.now());
        break;
      }

      const bySymbol = new Map(batch.candles.map((c) => [c.symbol, c.points]));
      const dbRows = await lookupDbRowsForTargetDate(candidates.map((c) => c.id), targetLocalDate);

      const observations: Array<{ etfId: string; symbol: string; classification: ShadowClassification }> = [];
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
        observations.push({ etfId: etf.id, symbol: etf.data_source, classification: c });
        if (c === "SOURCE_MISSING" && sourceMissingSymbols.length < 20) sourceMissingSymbols.push(etf.data_source);
        if (c === "NO_BAR_FOR_TARGET_DATE" && noBarSymbols.length < 20) noBarSymbols.push(etf.data_source);
        if (c === "NEW" && newSymbols.length < 20) newSymbols.push(etf.data_source);
        if (c === "CHANGED" && changedSymbols.length < 20) changedSymbols.push(etf.data_source);
      }
      const isLastBatch = candidates.length < SPARK_MAX_SYMBOLS_PER_BATCH;
      state = advanceSweep(state, { ok: true, isLastBatch, observations }, Date.now(), candidates[candidates.length - 1].id);
      if (isLastBatch) break;
    }

    // Phase 2: re-check only the bounded set of still-pending (SOURCE_MISSING/NO_BAR) ETFs from
    // this or any prior invocation — never a full re-sweep. Skipped entirely if Phase 1 hit a fetch
    // error, a rate limit, or the time budget this invocation.
    if (state.sweepComplete && !fetchFailedThisMarket && !rateLimitStop) {
      const pendingEntries = state.pending;
      for (let i = 0; i < pendingEntries.length; i += SPARK_MAX_SYMBOLS_PER_BATCH) {
        if (Date.now() - startedMs > TIME_BUDGET_MS) break;
        const chunk = pendingEntries.slice(i, i + SPARK_MAX_SYMBOLS_PER_BATCH);

        await sleep(REQUEST_DELAY_MS);
        const batch = await fetchSparkBatch(chunk.map((p) => p.symbol));
        if (batch.rateLimited) { rateLimitStop = true; break; }
        if (batch.error) {
          fetchErrorCount += chunk.length;
          fetchFailedThisMarket = true;
          state = advanceSweep(state, { ok: false }, Date.now());
          break;
        }

        const bySymbol = new Map(batch.candles.map((c) => [c.symbol, c.points]));
        const dbRows = await lookupDbRowsForTargetDate(chunk.map((p) => p.etfId), targetLocalDate);

        const observations: Array<{ etfId: string; symbol: string; classification: ShadowClassification }> = [];
        for (const p of chunk) {
          requested++;
          const sparkSymbolPresent = bySymbol.has(p.symbol);
          const points = bySymbol.get(p.symbol) ?? [];
          const picked = pickClosedCandle(points, job, targetLocalDate, now);
          const dbRow = dbRows.get(p.etfId);
          const dbDate = dbRow?.date ?? null;
          const dbClose = dbRow?.close ?? null;
          const sparkDate = picked ? targetLocalDate : null;
          const sparkClose = picked?.close ?? null;
          const c = classify({ dbDate, dbClose, sparkSymbolPresent, sparkDate, sparkClose });
          counts[c]++;
          observations.push({ etfId: p.etfId, symbol: p.symbol, classification: c });
          if (c === "SOURCE_MISSING" && sourceMissingSymbols.length < 20) sourceMissingSymbols.push(p.symbol);
          if (c === "NO_BAR_FOR_TARGET_DATE" && noBarSymbols.length < 20) noBarSymbols.push(p.symbol);
          if (c === "NEW" && newSymbols.length < 20) newSymbols.push(p.symbol);
          if (c === "CHANGED" && changedSymbols.length < 20) changedSymbols.push(p.symbol);
        }
        state = advanceSweep(state, { ok: true, isLastBatch: true, observations }, Date.now());
      }
    }

    const marketDone = isMarketDone(state);
    const nextPersisted: PersistedState = marketDone
      ? { v: 2, lastDoneDate: targetLocalDate, inProgress: null }
      : { v: 2, lastDoneDate, inProgress: state };
    await writeCheckpoint(JOB, checkpointKey, runId, {
      lastSymbol: JSON.stringify(nextPersisted),
      processed: requested,
      succeeded: counts.SAME + counts.CHANGED + counts.NEW + counts.DB_NEWER,
      failed: counts.SOURCE_MISSING + counts.NO_BAR_FOR_TARGET_DATE + fetchErrorCount,
    });

    marketDetails.push({
      jobId, status: "ELIGIBLE", targetLocalDate, requested, classifications: counts, fetchErrorCount,
      pendingCount: state.pending.length, sourceMissingSymbols, noBarSymbols, newSymbols, changedSymbols, doneForToday: marketDone,
    });
    if (fetchFailedThisMarket) continue; // move on to the next market rather than aborting the run
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
  }

  // Any considered job that never got a turn this invocation (loop broke on time budget / rate limit
  // before reaching it) is reported as NOT_REACHED, distinct from NOT_ELIGIBLE.
  const seenJobIds = new Set(marketDetails.map((m) => m.jobId));
  for (const jobId of consideredJobIds) {
    if (seenJobIds.has(jobId)) continue;
    marketDetails.push({
      jobId, status: "NOT_REACHED", targetLocalDate: null, requested: 0, classifications: emptyCounts(), fetchErrorCount: 0, pendingCount: 0,
      sourceMissingSymbols: [], noBarSymbols: [], newSymbols: [], changedSymbols: [], doneForToday: false,
    });
  }

  const status = rateLimitStop ? "PARTIAL" : timeBudgetStop ? "PARTIAL" : "COMPLETED";
  const totalRequested = marketDetails.reduce((s, m) => s + m.requested, 0);
  const totalFetchErrors = marketDetails.reduce((s, m) => s + m.fetchErrorCount, 0);
  const totalFailed = marketDetails.reduce((s, m) => s + m.classifications.SOURCE_MISSING + m.classifications.NO_BAR_FOR_TARGET_DATE, 0) + totalFetchErrors;
  await finishRun(runId, JOB, "YAHOO_SPARK", startedMs, {
    status,
    attempted: totalRequested,
    completed: totalRequested - totalFailed,
    inserted: 0, // shadow mode — never writes price rows
    updated: 0, // shadow mode — never writes price rows
    failed: totalFailed,
    retryableFailures: totalFetchErrors,
    checkpointAfter: null,
    details: { time_budget_stop: timeBudgetStop, rate_limit_stop: rateLimitStop, markets: marketDetails, unmapped_total: unmappedTotal, unmapped_by_suffix: unmappedBySuffix },
  });

  return Response.json({ ok: true, job: JOB, runId, status, timeBudgetStop, rateLimitStop, markets: marketDetails, unmappedTotal, unmappedBySuffix, universeTotal });
}
