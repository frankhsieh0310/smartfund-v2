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

// 2026-11-02（VERIFIED，10檔JPMorgan小/中型股基金全部卡在PRICE_JUMP_REVIEW根因修正）：
// reviewPriceJump()原本的第二意見用candle.chartPreviousClose（Yahoo Spark meta欄位）——VERIFIED
// 這個欄位代表的是「這次fetchSparkBatch的range=5d視窗開始之前」那一天的收盤，不是「目標交易日的
// 前一個交易日」。如果真正的價格變動發生在視窗中段（這次是10/26，10/26~10/29這4天在Yahoo自己的
// 資料裡已經穩定在新價位、YCharts等第三方資料也獨立佐證新價位才是正確的），chartPreviousClose
// 永遠停在變動前的舊價位，reviewPriceJump每天都會誤判成「還在跳動」，10檔基金因此連續好幾天卡在
// PRICE_JUMP_REVIEW，從未被改判DB_DISCONTINUITY、永遠寫不進去。改成直接從同一次Spark回應的
// points陣列裡找「目標交易日前一個實際交易日」的收盤價，這才是真正跟「昨天」比較，不是跟「視窗
// 起點之前」比較。只改這支route自己的判斷邏輯，不動lib/market-close-sync下任何共用檔案。
function previousTradingDayClose(
  points: Array<{ timestampUnix: number; close: number | null }>,
  beforeUnix: number,
): number | null {
  let best: { timestampUnix: number; close: number | null } | null = null;
  for (const p of points) {
    if (p.timestampUnix < beforeUnix && (!best || p.timestampUnix > best.timestampUnix)) best = p;
  }
  return best?.close ?? null;
}

// 2026-11-04（使用者核准，「台灣買不到的不放」原則）：原本只憑currency/isActive/dataSource，
// VERIFIED候選清單30,258檔裡只有619檔（TDCC_OPENDATA_3-2：616、SITCA_NAV_CSV：3）在
// tw_purchasable_classification裡是APPROVED，其餘29,639檔（含JPMorgan那8檔美國本地共同基金）
// 根本不是台灣核准銷售的基金，純粹因為currency=USD就被追蹤淨值、誤判PRICE_JUMP_REVIEW。改成
// 只取APPROVED的基金，台灣買不到的自然不會再被排進候選清單、也不會再觸發這個異常。
async function computeUsFundCandidateIds(): Promise<string[]> {
  const rows = await prisma.fund.findMany({
    where: {
      currency: "USD", isActive: true, dataSource: { not: null },
      id: { in: await approvedFundIds() },
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

async function approvedFundIds(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ asset_id: string }[]>(
    `SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED'`,
  );
  return rows.map((r) => r.asset_id);
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
          const independentPreviousClose = previousTradingDayClose(candle!.points, picked.timestampUnix);
          const jumpOutcome = reviewPriceJump(nav, independentPreviousClose);
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

  // 2026-10-22（使用者核准，三.三稽核發現）: 之前只看rate/time限制，writeErrorCount或write
  // gate開著卻written=0的情況完全沒guard。
  const status = rateLimitStop || timeBudgetStop ? "PARTIAL"
    : writeErrorCount > 0 ? "PARTIAL"
    : writeEnabledThisRun && attempted > 0 && written === 0 ? "PARTIAL"
    : "COMPLETED";
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
