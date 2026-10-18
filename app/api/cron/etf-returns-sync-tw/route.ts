// Dedicated daily-refresh cron for TW-listed ETF returns (Yahoo奇摩's own page,
// lib/yahoo/twPerformancePage.ts) — split out of app/api/cron/etf-returns-sync/route.ts on
// 2026-10-16 because that route's shared TIME_BUDGET_MS/missingIds ordering blended this small
// (~460-etf), expensive (3.2s/item, rate-limit-conscious pacing per user instruction) population
// together with the much larger (~16,000-etf) non-TW population's cheap (0.4s/item) one, with no
// priority separation. An alphabetically-ordered missingIds draw could spend a whole invocation's
// budget on cheap non-TW items before a TW item's turn came up, which is how some TW ETFs (confirmed
// live: 00980A) went 4-7 days between refreshes despite the parent route's 15-minute cron cadence —
// not a rate-limiting problem (lib/yahoo/twPerformancePage.ts hits tw.stock.yahoo.com directly, no
// auth/crumb dance, separate from the global API's query2.finance.yahoo.com this project also uses)
// and not a sleep-delay problem (user instruction: never shorten YAHOO_TW_REQUEST_DELAY_MS) — purely
// budget dilution from sharing one pool with a much bigger population.
//
// This route's own candidate universe is EXACTLY lib/etf-returns-sync/twUniverse.ts's
// TW_ELIGIBLE_SQL_CONDITION (active, recently-priced, .TW/.TWO-suffixed or override-eligible) — the
// parent route excludes this exact same set, so the two routes partition the work with no overlap
// and no duplicate Yahoo hits. Both write to and read from the SAME shared checkpoint
// (CHECKPOINT_KEY, lastProcessedDate/failureState) as the parent route, so "done today" status is
// unified regardless of which route did the work.
//
// Throughput proof (see docs/specs/etf-returns-sync-tw-coverage.md for the full writeup): 466
// TW-eligible ETFs as of 2026-10-16, budget 260s/run, 3.2s sleep + ~0.5-1s real fetch latency per
// item (~4.2s/item conservative) -> ~61 items/full-budget run -> ceil(466/61) = 8 full-budget runs
// needed to cover the WHOLE universe once. Scheduled every 15 minutes (96 opportunities/day) gives
// 12x headroom over the 8 actually needed, so one trading day comfortably covers all of them even
// accounting for some invocations finding little or nothing left to do once the day's backlog
// clears early (the desired steady state, not a failure).
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint, hourBucketKey } from "@/lib/cloud-ingestion/runContext";
import { fetchYahooTwPerformance, YahooTwRateLimitedError } from "@/lib/yahoo/twPerformancePage";
import { isWriteEnabled, currentRunMode } from "@/lib/etf-returns-sync/writeGate";
import { writeBatchIfEnabled, type WriteCandidate, type TrailingReturns } from "@/lib/etf-returns-sync/returnsWriter";
import { nextStateAfterOutcome, orderForInvocation, type EtfFailureStateMap } from "@/lib/etf-returns-sync/failureState";
import { missingForToday, type LastProcessedDateMap, type LastProcessedVersionMap } from "@/lib/etf-returns-sync/completion";
import {
  resolveWriteDatesBatch, fetchLatestReturn6mBatch, writeEtfsRankingColumnsBatch, type EtfsRankingEntry,
} from "@/lib/etf-returns-sync/batchHelpers";
import { TW_ELIGIBLE_SQL_CONDITION } from "@/lib/etf-returns-sync/twUniverse";
import { loadExchangeCalendarRegistry } from "@/lib/market-close-sync/marketConfig";
import { mostRecentTradingDay } from "@/lib/market-close-sync/marketTime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 280;

const JOB = "ETF_RETURNS_SYNC_TW";
// Same shared checkpoint as the parent route (app/api/cron/etf-returns-sync/route.ts) -- both
// routes must agree on this key so "done today" status is unified between them.
const CHECKPOINT_KEY = "etf-returns-sync:cursor";
// Must match the parent route's ETF_RETURNS_SOURCE_VERSION exactly -- it's read from the SAME
// shared checkpoint, so a mismatch would make every TW ETF look "missing" to one route and "done"
// to the other.
const ETF_RETURNS_SOURCE_VERSION = "yahoo-tw-v1";
const TIME_BUDGET_MS = 260_000;
const YAHOO_TW_REQUEST_DELAY_MS = 3_200; // never shorten -- user instruction
const RECENT_PRICE_WINDOW_DAYS = 7;
const DATE_ALIGNMENT_WINDOW_DAYS = 3;
const FLUSH_BATCH_SIZE = 40;

const writerQuery = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

function todayLocalDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type EtfRow = { id: string; code: string; data_source: string; yahoo_symbol_override: string | null };

const ALL_NULL_RETURNS: TrailingReturns = {
  r1d: null, r1m: null, r3m: null, r6m: null, rytd: null, r1y: null, r3y: null, r5y: null,
};

async function computeTwEligibleIds(): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT bare.id FROM etfs bare
     WHERE bare.is_active = true AND bare.data_source IS NOT NULL
       AND bare.price_updated_at >= NOW() - INTERVAL '${RECENT_PRICE_WINDOW_DAYS} days'
       AND ${TW_ELIGIBLE_SQL_CONDITION}`,
  );
  return new Set(rows.map((r) => r.id));
}

// 2026-10-16: this route's FIRST real production invocation crashed with an unhandled
// PrismaClientKnownRequestError (a real param-shape bug in the candidate query, since fixed) before
// ever reaching finishRun -- leaving its production_scheduler_runs row stuck IN_PROGRESS forever,
// exactly the same symptom offshore-nav-tdcc-sync's 60s timeout caused, just from a different root
// cause. The parent route (etf-returns-sync) has the same exposure (no top-level catch), but this is
// the one that actually hit it today -- wrapping GET so ANY future unexpected error still reaches
// finishRun with a FAILED status instead of leaving the row stuck until the next hour's staleness
// TTL takes over.
export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  let runIdForErrorHandling: string | null = null;
  let startedMsForErrorHandling = Date.now();
  try {
    return await runSweep(request, (runId, startedMs) => {
      runIdForErrorHandling = runId;
      startedMsForErrorHandling = startedMs;
    });
  } catch (error) {
    if (runIdForErrorHandling) {
      try {
        await finishRun(runIdForErrorHandling, JOB, "YAHOO_TW_PERFORMANCE_PAGE", startedMsForErrorHandling, {
          status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
          checkpointAfter: null, error: error instanceof Error ? error.message : String(error),
          details: { run_mode: currentRunMode(), crashed: true },
        });
      } catch { /* best-effort -- never let the error handler itself throw and mask the real error */ }
    }
    throw error;
  }
}

async function runSweep(request: Request, onRunStarted: (runId: string, startedMs: number) => void): Promise<Response> {
  const startedMs = Date.now();
  const today = todayLocalDate();
  const writeEnabledThisRun = isWriteEnabled();
  // 2026-10-18: resolveWriteDatesBatch's "no recent row" fallback previously defaulted to literal
  // `today`. This route's universe is exactly TW-listed ETFs, so the TWSE calendar is correct here.
  const registry = await loadExchangeCalendarRegistry();
  const twseJob = registry.jobs.find((j) => j.id === "twse-yahoo-daily")!;
  const fallbackTradingDay = mostRecentTradingDay(twseJob, today);

  const coreUniverseIds = await computeTwEligibleIds();
  const coreIdsArray = [...coreUniverseIds];

  const before = await readCheckpoint(CHECKPOINT_KEY);
  let failureStateMap: EtfFailureStateMap = {};
  let lastProcessedDate: LastProcessedDateMap = {};
  let lastProcessedVersion: LastProcessedVersionMap = {};
  try {
    const persisted = before?.lastSymbol ? JSON.parse(before.lastSymbol) : null;
    if (persisted?.failureState) failureStateMap = persisted.failureState;
    if (persisted?.lastProcessedDate) lastProcessedDate = persisted.lastProcessedDate;
    if (persisted?.lastProcessedVersion) lastProcessedVersion = persisted.lastProcessedVersion;
  } catch { /* corrupt/old checkpoint -- start fresh rather than block the sweep */ }

  const missingIds = missingForToday(coreIdsArray, lastProcessedDate, today, lastProcessedVersion, ETF_RETURNS_SOURCE_VERSION);

  const runKey = hourBucketKey(`${JOB.toLowerCase()}`);
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_TW_PERFORMANCE_PAGE", runKey,
    universeCount: coreUniverseIds.size, batchSize: 1, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey, runMode: currentRunMode() });
  }
  onRunStarted(runId, startedMs);

  if (missingIds.length === 0) {
    await finishRun(runId, JOB, "YAHOO_TW_PERFORMANCE_PAGE", startedMs, {
      status: "COMPLETED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
      checkpointAfter: null, details: { run_mode: currentRunMode(), core_universe_size: coreUniverseIds.size, missing_count: 0 },
    });
    return Response.json({ ok: true, job: JOB, runId, status: "COMPLETED", runMode: currentRunMode(), missingCount: 0, coreUniverseSize: coreUniverseIds.size });
  }

  const orderedMissing = orderForInvocation(missingIds, failureStateMap, today, Date.now());
  const notYetDueCount = missingIds.length - orderedMissing.length;

  const rows = await prisma.$queryRawUnsafe<EtfRow[]>(
    `SELECT bare.id, bare.code, bare.data_source,
            CASE WHEN bare.data_source !~ '\\.(TW|TWO)$'
                 THEN (SELECT suf.data_source FROM etfs suf WHERE suf.code = bare.code || '.TW' OR suf.code = bare.code || '.TWO' LIMIT 1)
                 ELSE NULL END AS yahoo_symbol_override
       FROM etfs bare WHERE bare.id = ANY($1::text[])`,
    orderedMissing,
  );
  const rowById = new Map(rows.map((r) => [r.id, r]));

  let attempted = 0, written = 0, noFundPerformanceCount = 0, transientFailureCount = 0, writeErrorCount = 0;
  let noFundPerformanceFirstWriteCount = 0;
  let timeBudgetStop = false;
  let rateLimitStop = false;
  const dateAlignmentCutoffIso = new Date(Date.now() - DATE_ALIGNMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let pending: Array<{ etfId: string; returns: TrailingReturns }> = [];

  async function flushPending() {
    if (pending.length === 0) return;
    const ids = pending.map((p) => p.etfId);
    const dateMap = await resolveWriteDatesBatch(writerQuery, ids, dateAlignmentCutoffIso);
    const candidates: WriteCandidate[] = pending.map((p) => ({ etfId: p.etfId, date: dateMap.get(p.etfId) ?? fallbackTradingDay, returns: p.returns }));
    const writeResult = await writeBatchIfEnabled(writerQuery, candidates, new Date().toISOString(), writeEnabledThisRun);
    written += writeResult.written;
    writeErrorCount += writeResult.writeErrorCount;
    if (writeEnabledThisRun && writeResult.written > 0) {
      for (const p of pending) {
        lastProcessedDate[p.etfId] = today;
        lastProcessedVersion[p.etfId] = ETF_RETURNS_SOURCE_VERSION;
      }
      const r6mMap = await fetchLatestReturn6mBatch(writerQuery, ids);
      const entries: EtfsRankingEntry[] = pending.map((p) => ({ etfId: p.etfId, returns: p.returns, return6mSync: r6mMap.get(p.etfId) ?? null }));
      await writeEtfsRankingColumnsBatch(writerQuery, entries);
    }
    pending = [];
  }

  for (const etfId of orderedMissing) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    if (rateLimitStop) break;
    const row = rowById.get(etfId);
    if (!row) continue;

    attempted++;
    const yahooSymbol = row.yahoo_symbol_override ?? row.data_source;
    let twReturns: TrailingReturns | null = null;
    let outcomeKind: "SUCCESS" | "NO_FUND_PERFORMANCE" | "TRANSIENT_FAILURE";
    try {
      const perf = await fetchYahooTwPerformance(yahooSymbol);
      if (perf) {
        twReturns = {
          r1d: null, r1m: perf.navReturn.m1, r3m: perf.navReturn.m3, r6m: perf.navReturn.m6,
          rytd: perf.navReturn.ytd, r1y: perf.navReturn.y1, r3y: perf.navReturn.y3, r5y: perf.navReturn.y5,
        };
        outcomeKind = "SUCCESS";
      } else {
        outcomeKind = "NO_FUND_PERFORMANCE";
      }
    } catch (e) {
      if (e instanceof YahooTwRateLimitedError) {
        rateLimitStop = true;
        await sleep(YAHOO_TW_REQUEST_DELAY_MS);
        break;
      }
      outcomeKind = "TRANSIENT_FAILURE";
    }

    const wasAlreadySkipNoPerf = failureStateMap[etfId]?.kind === "SKIP_NO_PERF";

    if (outcomeKind === "SUCCESS" && twReturns) {
      pending.push({ etfId: row.id, returns: twReturns });
    } else if (outcomeKind === "NO_FUND_PERFORMANCE") {
      noFundPerformanceCount++;
      if (!wasAlreadySkipNoPerf) {
        pending.push({ etfId: row.id, returns: ALL_NULL_RETURNS });
        noFundPerformanceFirstWriteCount++;
      }
    } else {
      transientFailureCount++;
    }

    const nextState = nextStateAfterOutcome(failureStateMap[etfId], outcomeKind, today, Date.now());
    if (nextState) failureStateMap[etfId] = nextState;
    else delete failureStateMap[etfId];

    if (pending.length >= FLUSH_BATCH_SIZE) await flushPending();

    await sleep(YAHOO_TW_REQUEST_DELAY_MS);
  }
  await flushPending();

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: JSON.stringify({ failureState: failureStateMap, lastProcessedDate, lastProcessedVersion }),
    processed: attempted, succeeded: written, failed: noFundPerformanceCount + transientFailureCount + writeErrorCount,
  });

  const status = timeBudgetStop || rateLimitStop ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, "YAHOO_TW_PERFORMANCE_PAGE", startedMs, {
    status, attempted, completed: written, inserted: written, updated: 0,
    failed: noFundPerformanceCount + transientFailureCount + writeErrorCount, retryableFailures: transientFailureCount,
    checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), core_universe_size: coreUniverseIds.size, missing_count_at_start: missingIds.length,
      not_yet_due_count: notYetDueCount, attempted, written,
      no_fund_performance_count: noFundPerformanceCount, no_fund_performance_first_write_count: noFundPerformanceFirstWriteCount,
      transient_failure_count: transientFailureCount, write_error_count: writeErrorCount,
      rate_limit_stop: rateLimitStop, time_budget_stop: timeBudgetStop,
      failure_state_map_size: Object.keys(failureStateMap).length,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(),
    coreUniverseSize: coreUniverseIds.size, missingCountAtStart: missingIds.length, notYetDueCount,
    attempted, written, noFundPerformanceCount, transientFailureCount, writeErrorCount,
    timeBudgetStop, rateLimitStop,
  });
}
