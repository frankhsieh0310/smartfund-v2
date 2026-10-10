// Market-close-sync — SHADOW MODE ONLY. Confirms, per eligible closed market, what Yahoo Spark would
// write vs what etf_history/etfs already have — and logs the comparison. Writes NOTHING to
// etf_history, etf_performance, or etfs. The only writes anywhere in this route are the existing
// run-log/checkpoint tables via beginRun/finishRun/writeCheckpoint (lib/cloud-ingestion/runContext),
// reused unmodified.
//
// ETF-only, per task scope. No stock/fund handling here.
//
// Task K: a market is now only reported doneForToday once lib/market-close-sync/completionState.ts's
// isMarketDone() says every candidate ETF reached a genuinely FINAL state.
//
// Task L, two more changes:
//   1. Core-universe filter (lib/market-close-sync/coreUniverse.ts) — the sweep's candidate query now
//      only considers ETFs that actually trade with some regularity, dropping dead/barely-traded rows
//      and Hong Kong's duplicate currency-counter listings from the daily rotation without touching
//      the DB rows themselves.
//   2. Scheduling fairness (lib/market-close-sync/scheduling.ts) — markets still mid-sweep are always
//      processed before markets only waiting on a confirmation recheck, a recheck is never attempted
//      before its entry is actually due, and no single market may consume more than 40% of the time
//      budget in one invocation — fixing Task K's observed failure mode where the UK's ~5,700-ETF
//      universe alone consumed entire 240s invocations and left most other markets NOT_REACHED, run
//      after run.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, hourBucketKey, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { loadExchangeCalendarRegistry, SUFFIX_TO_JOB_ID, NO_SUFFIX_EXCHANGE_FALLBACK, resolveJobForEtf, jobById } from "@/lib/market-close-sync/marketConfig";
import { findEligibleTradeDate, pickClosedCandle, localDateFromUnix } from "@/lib/market-close-sync/marketTime";
import { fetchSparkBatch, SPARK_MAX_SYMBOLS_PER_BATCH } from "@/lib/market-close-sync/sparkClient";
import { classify } from "@/lib/market-close-sync/shadowCompare";
import { emptyState, advanceSweep, isMarketDone, type MarketCompletionState } from "@/lib/market-close-sync/completionState";
import { classifyMarketPriority, orderMarketsForInvocation, isDueForRecheck, PER_MARKET_BUDGET_FRACTION } from "@/lib/market-close-sync/scheduling";
import { isHongKongCurrencyCounter, isCoreUniverseMemberFromCounts, SUFFIX_ACTIVITY_MEASURE } from "@/lib/market-close-sync/coreUniverse";
import { resolvePrice, type PriceSource } from "@/lib/market-close-sync/priceSource";
import type { ShadowClassification, ExchangeCalendarJob, SparkCandle } from "@/lib/market-close-sync/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "MARKET_CLOSE_SYNC_SHADOW";
const TIME_BUDGET_MS = 240_000;
const PER_MARKET_BUDGET_MS = TIME_BUDGET_MS * PER_MARKET_BUDGET_FRACTION;
const REQUEST_DELAY_MS = 300;
const DB_DATE_WINDOW_DAYS = 2;
const CORE_UNIVERSE_LOOKBACK_DAYS = 20;

// Task M: quoteResolutions tracks, for etf_ids currently resolved via QUOTE_AFTER_CLOSE, which
// targetLocalDate+price that was — purely this shadow pipeline's own bookkeeping (never written to
// etf_history). When a LATER invocation sees a real daily bar for the SAME etf_id+date, rule 4 fires:
// the bar wins, and the difference between it and the earlier quote is logged (see sourceSwitches on
// MarketDetail), never silently dropped. Entries are only ever kept for the market's CURRENT
// targetLocalDate — once a date is fully done and the market moves on, its old entries are simply
// not reloaded (there is no mechanism, nor a need, to keep watching a date this pipeline has already
// finished with).
type QuoteResolution = { etfId: string; targetLocalDate: string; symbol: string; price: number };
type PersistedState = { v: 2; lastDoneDate: string | null; inProgress: MarketCompletionState | null; quoteResolutions?: QuoteResolution[] };

function parsePersistedState(raw: string | null): PersistedState {
  if (!raw) return { v: 2, lastDoneDate: null, inProgress: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === 2) return parsed as PersistedState;
  } catch {
    // old v1 text or garbage — treated as a fresh start.
  }
  return { v: 2, lastDoneDate: null, inProgress: null };
}

type SourceSwitch = { symbol: string; quotePrice: number; barClose: number; diff: number };

/** Resolves one ETF's price (rule 1: BAR, rule 2: QUOTE_AFTER_CLOSE, rule 3: unresolved) and
 * classifies it against the DB row exactly as before — classify() itself is unaware of which source
 * won; it only ever sees an already-resolved (date, close) pair or null. Also applies rule 4: if this
 * resolves to BAR for an etf_id+date that quoteResolutions still remembers as QUOTE_AFTER_CLOSE, logs
 * the switch and the price delta, then forgets it (the bar is authoritative from here on). Mutates
 * quoteResolutions and sourceSwitches in place — called once per candidate, in both the sweep and the
 * recheck phase, so the two phases can never drift into different resolution logic. */
function resolveAndClassify(
  etf: { id: string; data_source: string },
  candle: SparkCandle | undefined,
  dbRows: Map<string, { date: string; close: number }>,
  job: ExchangeCalendarJob,
  targetLocalDate: string,
  now: Date,
  quoteResolutions: Map<string, QuoteResolution>,
  sourceSwitches: SourceSwitch[],
): { classification: ShadowClassification; sourceUsed: PriceSource | null } {
  const sparkSymbolPresent = candle !== undefined;
  const points = candle?.points ?? [];
  const picked = pickClosedCandle(points, job, targetLocalDate, now);
  const dbRow = dbRows.get(etf.id);
  const dbDate = dbRow?.date ?? null;
  const dbClose = dbRow?.close ?? null;

  const resolved = resolvePrice({
    job, targetLocalDate, barClose: picked?.close ?? null,
    quoteRegularMarketTimeUnix: candle?.regularMarketTimeUnix ?? null,
    quoteRegularMarketPrice: candle?.regularMarketPrice ?? null,
    localDateFromUnix,
  });

  const priorQuote = quoteResolutions.get(etf.id);
  if (resolved?.source === "BAR" && priorQuote?.targetLocalDate === targetLocalDate) {
    if (sourceSwitches.length < 20) {
      sourceSwitches.push({ symbol: etf.data_source, quotePrice: priorQuote.price, barClose: resolved.price, diff: resolved.price - priorQuote.price });
    }
    quoteResolutions.delete(etf.id);
  } else if (resolved?.source === "QUOTE_AFTER_CLOSE") {
    quoteResolutions.set(etf.id, { etfId: etf.id, targetLocalDate, symbol: etf.data_source, price: resolved.price });
  }

  const sparkDate = resolved ? targetLocalDate : null;
  const sparkClose = resolved?.price ?? null;
  const classification = classify({ dbDate, dbClose, sparkSymbolPresent, sparkDate, sparkClose });
  return { classification, sourceUsed: resolved?.source ?? null };
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
  pendingCount: number;
  sourceMissingSymbols: string[];
  noBarSymbols: string[];
  newSymbols: string[];
  changedSymbols: string[];
  doneForToday: boolean;
  priorityKind?: "SWEEP" | "RECHECK_DUE" | "WAITING" | "DONE";
  coreUniverseBefore?: number; // active+data_source candidates matching this market's suffix pattern, before the core filter
  coreUniverseAfter?: number; // same, after the core-universe + HK-counter filter
  barCount: number; // resolved via rule 1 (daily bar)
  quoteAfterCloseCount: number; // resolved via rule 2 (live quote, after close, bar not yet published)
  sourceSwitches: SourceSwitch[]; // rule 4: a later BAR superseded an earlier QUOTE_AFTER_CLOSE for the same etf+date
};

const emptyCounts = (): Record<ShadowClassification, number> => ({ NEW: 0, CHANGED: 0, SAME: 0, SOURCE_MISSING: 0, NO_BAR_FOR_TARGET_DATE: 0, DB_NEWER: 0 });

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

/** One aggregate pass over the WHOLE active+data_source universe deciding core-universe membership
 * (lib/market-close-sync/coreUniverse.ts) for every ETF at once — far cheaper than re-deriving it per
 * market/per batch. Returns the set of etf_ids that belong in the daily rotation. The activity
 * measure (volume vs close) is picked per-suffix via a SQL CASE mirroring SUFFIX_ACTIVITY_MEASURE —
 * kept in sync by a dedicated test (see coreUniverse.test.ts for the pure logic; the SQL pattern list
 * is re-derived from SUFFIX_ACTIVITY_MEASURE's own keys below, never hand-duplicated). */
async function computeCoreUniverse(): Promise<Set<string>> {
  const closeBasedSuffixes = Object.keys(SUFFIX_ACTIVITY_MEASURE); // e.g. [".VI", ".DU", ".F"]
  const closeBasedPatterns = closeBasedSuffixes.map((s) => `%${s}`);
  const rows = await prisma.$queryRawUnsafe<Array<{ etf_id: string; days_available: bigint; active_days: bigint }>>(
    `WITH ranked AS (
       SELECT h.etf_id, e.data_source, h.volume, h.close,
              row_number() OVER (PARTITION BY h.etf_id ORDER BY h.date DESC) AS rn
       FROM etf_history h
       JOIN etfs e ON e.id = h.etf_id
       WHERE e.is_active = true AND e.data_source IS NOT NULL
     ),
     scored AS (
       SELECT etf_id,
              CASE WHEN data_source LIKE ANY($1) THEN (close IS NOT NULL)
                   ELSE (volume IS NOT NULL AND volume > 0) END AS traded_positive
       FROM ranked WHERE rn <= $2
     )
     SELECT etf_id, count(*) AS days_available, count(*) FILTER (WHERE traded_positive) AS active_days
     FROM scored GROUP BY etf_id`,
    closeBasedPatterns, CORE_UNIVERSE_LOOKBACK_DAYS,
  );
  const core = new Set<string>();
  for (const r of rows) {
    if (isCoreUniverseMemberFromCounts(Number(r.days_available), Number(r.active_days))) core.add(r.etf_id);
  }
  return core;
}

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

type MarketContext = {
  jobId: string;
  job: NonNullable<ReturnType<typeof jobById>>;
  checkpointKey: string;
  lastDoneDate: string | null;
  targetLocalDate: string;
  state: MarketCompletionState;
  quoteResolutions: Map<string, QuoteResolution>;
  suffixPatterns: string[];
  fallbackExchanges: string[];
};

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const now = new Date();
  const registry = await loadExchangeCalendarRegistry();
  const { unmappedTotal, unmappedBySuffix, universeTotal } = await computeUnmapped(registry);
  const coreUniverseIds = await computeCoreUniverse();

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

  // Pass 0: resolve eligibility + load checkpoint state for every considered market. No network
  // calls here — just cheap per-market reads — so every market's priority can be classified before
  // deciding this invocation's processing order (Task L item 2: unswept markets before due rechecks).
  const contexts: MarketContext[] = [];
  for (const jobId of consideredJobIds) {
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
        barCount: 0, quoteAfterCloseCount: 0, sourceSwitches: [],
      });
      continue;
    }
    const { targetLocalDate } = eligibility;
    const state: MarketCompletionState = persisted.inProgress && persisted.inProgress.targetLocalDate === targetLocalDate
      ? persisted.inProgress
      : emptyState(targetLocalDate);
    const quoteResolutions = new Map<string, QuoteResolution>(
      (persisted.quoteResolutions ?? [])
        .filter((q) => q.targetLocalDate === targetLocalDate)
        .map((q) => [q.etfId, q]),
    );

    contexts.push({
      jobId, job, checkpointKey, lastDoneDate, targetLocalDate, state, quoteResolutions,
      suffixPatterns: (suffixesByJob.get(jobId) ?? []).map((s) => `%${s}`),
      fallbackExchanges: fallbackExchangesByJob.get(jobId) ?? [],
    });
  }

  // Task L item 2: SWEEP-priority markets (not yet fully scanned) always go before RECHECK_DUE
  // markets (sweepComplete, with at least one pending entry past its own wait). WAITING markets
  // (sweepComplete, pending, nothing due yet) and DONE markets get no turn at all this invocation —
  // never queried early, per the task's explicit "到期前不得重新查詢".
  const nowMsForPriority = Date.now();
  const withPriority = contexts.map((ctx) => ({ item: ctx, priority: classifyMarketPriority(ctx.state, nowMsForPriority) }));
  const priorityByJobId = new Map(withPriority.map((w) => [w.item.jobId, w.priority]));
  const orderedContexts = orderMarketsForInvocation(withPriority);

  for (const ctx of orderedContexts) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    if (rateLimitStop) break;

    const { jobId, job, checkpointKey, lastDoneDate, targetLocalDate } = ctx;
    let state = ctx.state;
    const marketStartedMs = Date.now();
    const marketDeadlineMs = Math.min(startedMs + TIME_BUDGET_MS, marketStartedMs + PER_MARKET_BUDGET_MS);

    const counts = emptyCounts();
    const sourceMissingSymbols: string[] = [];
    const noBarSymbols: string[] = [];
    const newSymbols: string[] = [];
    const changedSymbols: string[] = [];
    let requested = 0;
    let fetchErrorCount = 0;
    let fetchFailedThisMarket = false;
    let barCount = 0;
    let quoteAfterCloseCount = 0;
    const sourceSwitches: SourceSwitch[] = [];
    const { quoteResolutions } = ctx;

    // Phase 1: forward sweep, now filtered to the core universe (coreUniverseIds) and excluding
    // Hong Kong's duplicate currency-counter listings — both decided once per etf_id up front, not
    // per batch, so the SQL only ever returns candidates already known to belong in the rotation.
    while (!state.sweepComplete && Date.now() < marketDeadlineMs) {
      const rawCandidates = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; exchange: string | null; data_source: string }>>(
        `SELECT id, code, exchange, data_source
           FROM etfs
          WHERE is_active = true AND data_source IS NOT NULL AND id > $1
            AND (data_source LIKE ANY($2) OR (data_source NOT LIKE '%.%' AND exchange = ANY($3)))
          ORDER BY id ASC LIMIT $4`,
        state.cursorEtfId, ctx.suffixPatterns, ctx.fallbackExchanges, SPARK_MAX_SYMBOLS_PER_BATCH,
      );
      if (rawCandidates.length === 0) {
        state = advanceSweep(state, { ok: true, isLastBatch: true, observations: [] }, Date.now());
        break;
      }
      const lastRawId = rawCandidates[rawCandidates.length - 1].id;
      const isLastBatch = rawCandidates.length < SPARK_MAX_SYMBOLS_PER_BATCH;
      const candidates = rawCandidates.filter((c) => coreUniverseIds.has(c.id) && !isHongKongCurrencyCounter(c.data_source));

      if (candidates.length === 0) {
        // Every candidate in this id-range was filtered out (non-core or an HK currency counter) —
        // still a real batch of the sweep (cursor must advance), just nothing to fetch from Spark.
        state = advanceSweep(state, { ok: true, isLastBatch, observations: [] }, Date.now(), lastRawId);
        if (isLastBatch) break;
        continue;
      }

      await sleep(REQUEST_DELAY_MS);
      const batch = await fetchSparkBatch(candidates.map((c) => c.data_source));
      if (batch.rateLimited) { rateLimitStop = true; break; }
      if (batch.error) {
        fetchErrorCount += candidates.length;
        fetchFailedThisMarket = true;
        state = advanceSweep(state, { ok: false }, Date.now());
        break;
      }

      const byCandle = new Map(batch.candles.map((c) => [c.symbol, c]));
      const dbRows = await lookupDbRowsForTargetDate(candidates.map((c) => c.id), targetLocalDate);

      const observations: Array<{ etfId: string; symbol: string; classification: ShadowClassification }> = [];
      for (const etf of candidates) {
        requested++;
        const { classification: c, sourceUsed } = resolveAndClassify(
          etf, byCandle.get(etf.data_source), dbRows, job, targetLocalDate, now, quoteResolutions, sourceSwitches,
        );
        counts[c]++;
        if (sourceUsed === "BAR") barCount++;
        if (sourceUsed === "QUOTE_AFTER_CLOSE") quoteAfterCloseCount++;
        observations.push({ etfId: etf.id, symbol: etf.data_source, classification: c });
        if (c === "SOURCE_MISSING" && sourceMissingSymbols.length < 20) sourceMissingSymbols.push(etf.data_source);
        if (c === "NO_BAR_FOR_TARGET_DATE" && noBarSymbols.length < 20) noBarSymbols.push(etf.data_source);
        if (c === "NEW" && newSymbols.length < 20) newSymbols.push(etf.data_source);
        if (c === "CHANGED" && changedSymbols.length < 20) changedSymbols.push(etf.data_source);
      }
      state = advanceSweep(state, { ok: true, isLastBatch, observations }, Date.now(), lastRawId);
      if (isLastBatch) break;
    }

    // Phase 2: re-check ONLY the pending entries that are actually due (Task L item 2) — never the
    // full pending list. Skipped entirely if Phase 1 hit a fetch error, a rate limit, this market's
    // own 40%-budget deadline, or the global time budget.
    if (state.sweepComplete && !fetchFailedThisMarket && !rateLimitStop) {
      const nowMsForDue = Date.now();
      const duePending = state.pending.filter((p) => isDueForRecheck(p, nowMsForDue));
      for (let i = 0; i < duePending.length; i += SPARK_MAX_SYMBOLS_PER_BATCH) {
        if (Date.now() >= marketDeadlineMs || Date.now() - startedMs > TIME_BUDGET_MS) break;
        const chunk = duePending.slice(i, i + SPARK_MAX_SYMBOLS_PER_BATCH);

        await sleep(REQUEST_DELAY_MS);
        const batch = await fetchSparkBatch(chunk.map((p) => p.symbol));
        if (batch.rateLimited) { rateLimitStop = true; break; }
        if (batch.error) {
          fetchErrorCount += chunk.length;
          fetchFailedThisMarket = true;
          state = advanceSweep(state, { ok: false }, Date.now());
          break;
        }

        const byCandle = new Map(batch.candles.map((c) => [c.symbol, c]));
        const dbRows = await lookupDbRowsForTargetDate(chunk.map((p) => p.etfId), targetLocalDate);

        const observations: Array<{ etfId: string; symbol: string; classification: ShadowClassification }> = [];
        for (const p of chunk) {
          requested++;
          const { classification: c, sourceUsed } = resolveAndClassify(
            { id: p.etfId, data_source: p.symbol }, byCandle.get(p.symbol), dbRows, job, targetLocalDate, now, quoteResolutions, sourceSwitches,
          );
          counts[c]++;
          if (sourceUsed === "BAR") barCount++;
          if (sourceUsed === "QUOTE_AFTER_CLOSE") quoteAfterCloseCount++;
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
      ? { v: 2, lastDoneDate: targetLocalDate, inProgress: null, quoteResolutions: Array.from(quoteResolutions.values()) }
      : { v: 2, lastDoneDate, inProgress: state, quoteResolutions: Array.from(quoteResolutions.values()) };
    await writeCheckpoint(JOB, checkpointKey, runId, {
      lastSymbol: JSON.stringify(nextPersisted),
      processed: requested,
      succeeded: counts.SAME + counts.CHANGED + counts.NEW + counts.DB_NEWER,
      failed: counts.SOURCE_MISSING + counts.NO_BAR_FOR_TARGET_DATE + fetchErrorCount,
    });

    marketDetails.push({
      jobId, status: "ELIGIBLE", targetLocalDate, requested, classifications: counts, fetchErrorCount,
      pendingCount: state.pending.length, sourceMissingSymbols, noBarSymbols, newSymbols, changedSymbols, doneForToday: marketDone,
      priorityKind: priorityByJobId.get(jobId)?.kind,
      barCount, quoteAfterCloseCount, sourceSwitches,
    });
    if (fetchFailedThisMarket) continue;
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
  }

  // Any considered job that never got a turn this invocation is reported as NOT_REACHED, distinct
  // from NOT_ELIGIBLE and from the new WAITING state (sweepComplete, pending, nothing due yet — also
  // reported here since WAITING markets are deliberately given no turn at all, see orderMarketsForInvocation).
  const seenJobIds = new Set(marketDetails.map((m) => m.jobId));
  for (const jobId of consideredJobIds) {
    if (seenJobIds.has(jobId)) continue;
    const priority = priorityByJobId.get(jobId);
    marketDetails.push({
      jobId, status: "NOT_REACHED", targetLocalDate: null, requested: 0, classifications: emptyCounts(), fetchErrorCount: 0, pendingCount: 0,
      sourceMissingSymbols: [], noBarSymbols: [], newSymbols: [], changedSymbols: [], doneForToday: false,
      priorityKind: priority?.kind,
      barCount: 0, quoteAfterCloseCount: 0, sourceSwitches: [],
    });
  }

  // Core-universe before/after counts per market — read-only reporting pass, cheap (grouped count
  // queries), run once per invocation regardless of which markets actually got a turn above.
  for (const detail of marketDetails) {
    const suffixPatterns = (suffixesByJob.get(detail.jobId) ?? []).map((s) => `%${s}`);
    const fallbackExchanges = fallbackExchangesByJob.get(detail.jobId) ?? [];
    if (suffixPatterns.length === 0 && fallbackExchanges.length === 0) continue;
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; data_source: string }>>(
      `SELECT id, data_source FROM etfs
        WHERE is_active = true AND data_source IS NOT NULL
          AND (data_source LIKE ANY($1) OR (data_source NOT LIKE '%.%' AND exchange = ANY($2)))`,
      suffixPatterns, fallbackExchanges,
    );
    detail.coreUniverseBefore = rows.length;
    detail.coreUniverseAfter = rows.filter((r) => coreUniverseIds.has(r.id) && !isHongKongCurrencyCounter(r.data_source)).length;
  }

  const status = rateLimitStop ? "PARTIAL" : timeBudgetStop ? "PARTIAL" : "COMPLETED";
  const totalRequested = marketDetails.reduce((s, m) => s + m.requested, 0);
  const totalFetchErrors = marketDetails.reduce((s, m) => s + m.fetchErrorCount, 0);
  const totalFailed = marketDetails.reduce((s, m) => s + m.classifications.SOURCE_MISSING + m.classifications.NO_BAR_FOR_TARGET_DATE, 0) + totalFetchErrors;
  await finishRun(runId, JOB, "YAHOO_SPARK", startedMs, {
    status,
    attempted: totalRequested,
    completed: totalRequested - totalFailed,
    inserted: 0,
    updated: 0,
    failed: totalFailed,
    retryableFailures: totalFetchErrors,
    checkpointAfter: null,
    details: { time_budget_stop: timeBudgetStop, rate_limit_stop: rateLimitStop, markets: marketDetails, unmapped_total: unmappedTotal, unmapped_by_suffix: unmappedBySuffix, core_universe_size: coreUniverseIds.size },
  });

  return Response.json({ ok: true, job: JOB, runId, status, timeBudgetStop, rateLimitStop, markets: marketDetails, unmappedTotal, unmappedBySuffix, universeTotal, coreUniverseSize: coreUniverseIds.size });
}
