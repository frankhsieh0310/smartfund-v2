// Task Y: US mutual-fund NAV sync via Yahoo Spark — same design as market-close-sync (reusing its
// sparkClient.ts / marketTime.ts / priceSanity.ts read-only, never modifying them), applied to
// `funds`/`fund_history` instead of `etfs`/`etf_performances`. A brand-new file/endpoint; does not
// touch lib/yahoo/fundIngest.ts or app/api/cron/yahoo-fund-full-sweep/route.ts at all.
//
// SHADOW MODE BY DEFAULT: unless FUND_NAV_SYNC_WRITE is exactly "on" (lib/us-fund-nav-sync/
// writeGate.ts), this route fetches and classifies but writes nothing.
//
// Target date: the most recent US trading day that is definitely closed + past a stabilization
// delay (findEligibleTradeDate with maxTradingDayLookback=1 — always the single latest closed day,
// never market-close-sync's multi-day backlog scan, since this feature has no multi-market backlog
// concept of its own). Completion is DB-truth (fund_history has a row for this date), not
// checkpoint-based — the checkpoint below is purely the failure-state map + a same-day candidate
// list cache, never trusted to mean "done" on its own.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { fetchSparkBatch, SPARK_MAX_SYMBOLS_PER_BATCH } from "@/lib/market-close-sync/sparkClient";
import { findEligibleTradeDate, pickClosedCandle } from "@/lib/market-close-sync/marketTime";
import { checkPriceSanity, reviewPriceJump } from "@/lib/market-close-sync/priceSanity";
import type { ExchangeCalendarJob } from "@/lib/market-close-sync/types";
import { isWriteEnabled, currentRunMode } from "@/lib/us-fund-nav-sync/writeGate";
import { writeBatchIfEnabled, type QueryFn } from "@/lib/us-fund-nav-sync/navWriter";
import { lookupDoneFundIds } from "@/lib/us-fund-nav-sync/completion";
import {
  nextStateAfterOutcome, orderForInvocation, type FundFailureStateMap, type FundOutcomeKind,
} from "@/lib/us-fund-nav-sync/failureState";
import type { FundNavCandidate } from "@/lib/us-fund-nav-sync/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "US_FUND_NAV_SYNC";
const TIME_BUDGET_MS = 240_000;
const CHECKPOINT_KEY = "us-fund-nav-sync:cursor";
const CANDIDATE_LIST_CACHE_KEY = "us-fund-nav-sync:candidate-list-cache";

const writerQuery: QueryFn = (sql, params) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

// NAV is typically published US-Eastern evening, a few hours after the 16:00 close — 180 minutes
// (7pm ET) is a conservative floor; the real per-fund publish time varies by fund company, which is
// exactly why DB-truth completion (not a fixed clock) decides when a fund is actually done.
const US_FUND_MARKET_JOB: ExchangeCalendarJob = {
  id: "US_FUND_NAV", market: "US_FUND", exchange: "NYSE", exchanges: ["NYSE", "NASDAQ"],
  country: "US", timezone: "America/New_York",
  regularSession: { open: "09:30", close: "16:00" },
  stabilizationDelayMinutes: 180,
  weekdays: [1, 2, 3, 4, 5], holidays: [], schedulerEnabled: true,
};

type FundRow = { id: string; data_source: string; latest_nav: string | null };

async function computeUsFundCandidateIds(): Promise<string[]> {
  const rows = await prisma.fund.findMany({
    where: { currency: "USD", isActive: true, dataSource: { not: null } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

async function getCandidateIdsCachedForToday(today: string): Promise<string[]> {
  const cached = await readCheckpoint(CANDIDATE_LIST_CACHE_KEY);
  try {
    const parsed = cached?.lastSymbol ? JSON.parse(cached.lastSymbol) : null;
    if (parsed?.date === today && Array.isArray(parsed?.ids)) return parsed.ids;
  } catch { /* corrupt/old cache entry — recompute below */ }

  const ids = await computeUsFundCandidateIds();
  await writeCheckpoint(JOB, CANDIDATE_LIST_CACHE_KEY, `cache:${today}`, {
    lastSymbol: JSON.stringify({ date: today, ids }),
    processed: ids.length, succeeded: ids.length, failed: 0,
  });
  return ids;
}

function todayLocalDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const now = new Date();
  const writeEnabledThisRun = isWriteEnabled();

  // maxTradingDayLookback=1 + isDoneForDate always false: always resolves to the single most
  // recent US trading day that is closed+past-delay, independent of any per-fund completion state
  // (completion is checked per-candidate below, not at the date-selection level).
  const tradeDate = findEligibleTradeDate(US_FUND_MARKET_JOB, now, () => false, 1);
  if (!tradeDate.eligible) {
    return Response.json({ ok: true, job: JOB, status: "NOT_ELIGIBLE", reason: tradeDate.reason, runMode: currentRunMode() });
  }
  const targetDate = tradeDate.targetLocalDate;
  const today = todayLocalDate();

  const candidateIds = await getCandidateIdsCachedForToday(today);

  const before = await readCheckpoint(CHECKPOINT_KEY);
  let failureStateMap: FundFailureStateMap = {};
  try {
    const persisted = before?.lastSymbol ? JSON.parse(before.lastSymbol) : null;
    if (persisted?.failureState) failureStateMap = persisted.failureState;
  } catch { /* corrupt/old checkpoint — start fresh rather than block the sweep */ }

  const doneIds = await lookupDoneFundIds(writerQuery, candidateIds, targetDate);
  const missingIds = candidateIds.filter((id) => !doneIds.has(id));

  const runKey = `us-fund-nav-sync:${targetDate}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_SPARK", runKey,
    universeCount: candidateIds.length, batchSize: SPARK_MAX_SYMBOLS_PER_BATCH, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present for this trade date", runKey, runMode: currentRunMode() });
  }

  if (missingIds.length === 0) {
    await finishRun(runId, JOB, "YAHOO_SPARK", startedMs, {
      status: "COMPLETED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
      checkpointAfter: null, details: { run_mode: currentRunMode(), target_date: targetDate, universe_count: candidateIds.length, missing_count: 0 },
    });
    return Response.json({ ok: true, job: JOB, runId, status: "COMPLETED", runMode: currentRunMode(), targetDate, missingCount: 0, universeCount: candidateIds.length });
  }

  const nowMsForOrdering = Date.now();
  const orderedMissing = orderForInvocation(missingIds, failureStateMap, today, nowMsForOrdering);
  const notYetDueCount = missingIds.length - orderedMissing.length;

  const rows = await prisma.$queryRawUnsafe<FundRow[]>(
    `SELECT id, data_source, latest_nav::text FROM funds WHERE id = ANY($1::text[])`,
    orderedMissing,
  );
  const rowById = new Map(rows.map((r) => [r.id, r]));

  let attempted = 0, written = 0, noDataCount = 0, transientFailureCount = 0, writeErrorCount = 0;
  let unitMismatchCount = 0, priceJumpReviewCount = 0, dbDiscontinuityCount = 0;
  let timeBudgetStop = false;
  let rateLimitStop = false;

  for (let i = 0; i < orderedMissing.length; i += SPARK_MAX_SYMBOLS_PER_BATCH) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    if (rateLimitStop) break;

    const batchIds = orderedMissing.slice(i, i + SPARK_MAX_SYMBOLS_PER_BATCH);
    const batchRows = batchIds.map((id) => rowById.get(id)).filter((r): r is FundRow => !!r);
    if (batchRows.length === 0) continue;

    attempted += batchRows.length;
    let sparkResult;
    try {
      sparkResult = await fetchSparkBatch(batchRows.map((r) => r.data_source));
    } catch {
      sparkResult = { httpStatus: 0, rateLimited: false, candles: [], error: "fetch threw" };
    }
    if (sparkResult.rateLimited) {
      rateLimitStop = true; // never retry around a 401/403/429 — same rule every pipeline this session follows
      break;
    }

    const candlesBySymbol = new Map(sparkResult.candles.map((c) => [c.symbol, c]));
    const candidates: FundNavCandidate[] = [];

    for (const row of batchRows) {
      const fundId = row.id;
      const candle = candlesBySymbol.get(row.data_source);
      const outcome: FundOutcomeKind = (() => {
        if (sparkResult.error) return "TRANSIENT_FAILURE";
        if (!candle || candle.points.length === 0) return "NO_DATA";
        const picked = pickClosedCandle(candle.points, US_FUND_MARKET_JOB, targetDate, now);
        if (!picked || picked.close == null) return "NO_DATA";
        return "SUCCESS";
      })();

      if (outcome === "SUCCESS") {
        const picked = pickClosedCandle(candle!.points, US_FUND_MARKET_JOB, targetDate, now)!;
        const nav = picked.close as number;
        const lastKnownNav = row.latest_nav != null ? Number(row.latest_nav) : null;
        const sanity = checkPriceSanity(nav, lastKnownNav);
        if (sanity === "UNIT_MISMATCH") {
          unitMismatchCount++; // held back — never written, flagged for review
        } else if (sanity === "PRICE_JUMP_REVIEW") {
          const jumpOutcome = reviewPriceJump(nav, candle!.chartPreviousClose);
          if (jumpOutcome === "DB_DISCONTINUITY") {
            dbDiscontinuityCount++;
            candidates.push({ fundId, symbol: row.data_source, date: targetDate, nav });
          } else {
            priceJumpReviewCount++; // no independent corroboration — held back
          }
        } else {
          candidates.push({ fundId, symbol: row.data_source, date: targetDate, nav });
        }
      } else if (outcome === "NO_DATA") {
        noDataCount++;
      } else {
        transientFailureCount++;
      }

      const nextState = nextStateAfterOutcome(failureStateMap[fundId], outcome, today, Date.now());
      if (nextState) failureStateMap[fundId] = nextState;
      else delete failureStateMap[fundId];
    }

    if (candidates.length > 0) {
      const writeResult = await writeBatchIfEnabled(writerQuery, candidates, new Date().toISOString(), writeEnabledThisRun);
      written += writeResult.written;
      writeErrorCount += writeResult.writeErrorCount;
    }
  }

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: JSON.stringify({ failureState: failureStateMap }),
    processed: attempted, succeeded: written, failed: noDataCount + transientFailureCount + writeErrorCount,
  });

  const status = rateLimitStop || timeBudgetStop ? "PARTIAL" : "COMPLETED";
  const fetchFailed = noDataCount + transientFailureCount;
  await finishRun(runId, JOB, "YAHOO_SPARK", startedMs, {
    status, attempted, completed: written, inserted: written, updated: 0, failed: fetchFailed + writeErrorCount, retryableFailures: transientFailureCount,
    checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), target_date: targetDate, universe_count: candidateIds.length, missing_count_at_start: missingIds.length,
      not_yet_due_count: notYetDueCount, attempted, written,
      no_data_count: noDataCount, transient_failure_count: transientFailureCount, write_error_count: writeErrorCount,
      unit_mismatch_count: unitMismatchCount, price_jump_review_count: priceJumpReviewCount, db_discontinuity_count: dbDiscontinuityCount,
      rate_limit_stop: rateLimitStop, failure_state_map_size: Object.keys(failureStateMap).length,
      write_env_var_present: process.env.FUND_NAV_SYNC_WRITE !== undefined,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(), targetDate,
    universeCount: candidateIds.length, missingCountAtStart: missingIds.length, notYetDueCount,
    attempted, written, noDataCount, transientFailureCount, writeErrorCount,
    unitMismatchCount, priceJumpReviewCount, dbDiscontinuityCount,
    timeBudgetStop, rateLimitStop,
  });
}
