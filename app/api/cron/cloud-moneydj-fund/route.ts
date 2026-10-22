// Cloud MoneyDJ fund worker — bounded, idempotent, resumable via DB checkpoint.
//
// Reuses the MoneyDJ disclosure contract from
// scripts/data/global-fund/run-fund-moneydj-disclosure.ts (see lib/cloud-ingestion/moneydjFundDisclosure.ts).
// No scraper logic is duplicated beyond that single-page parse contract; the DB write path,
// conflict target and advisory lock are identical to the existing local job.
//
// Trigger: GitHub Actions schedule (:02/:22/:37/:52, repo secret SMARTFUND_CRON_SECRET) AND Vercel's
// native cron (vercel.json, */20 * * * *, auto-sends Bearer $CRON_SECRET) -- both call the same public
// GET with `Authorization: Bearer <CRON_SECRET>`, and both are expected/intentional: run_key is a
// 15-minute bucket (see quarterHourBucketKey below), not per-trigger-source, so whichever of the two
// mechanisms lands first in a given 15-minute window does the real work and the other is a safe no-op.
// One invocation: read ROLLING checkpoint -> next <=BATCH MASTER-FUND portfolios (one representative
// share class per verified master_fund_id, standalone funds unaffected) -> fetch MoneyDJ -> compare
// 資料月份 -> only-newer write -> advance checkpoint -> run log -> return.
// 403/429 => bounded backoff, mark PARTIAL, stop early, never clear existing data. No loop.
//
// MASTER_FUND_DEDUP: implemented 2026-10-08 — see nextCodes()/freshnessCutoffDate() below.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import {
  fetchMoneydjDisclosure,
  MoneydjHttpError,
  MoneydjHoldingsNameOnlyError,
  persistMoneydjDisclosure,
  persistMoneydjDisclosureBatch,
  persistNameOnlyHoldings,
  MONEYDJ_SOURCE,
} from "@/lib/cloud-ingestion/moneydjFundDisclosure";
import { isMoneydjFundBatchRefreshEnabled, moneydjFundBatchRefreshInnerSize } from "@/lib/cron/moneydjFundBatchRefreshGate";
import {
  beginRun,
  finishRun,
  readCheckpoint,
  writeCheckpoint,
  type CheckpointRow,
} from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_MONEYDJ_FUND";
const PROVIDER = "MONEYDJ";
const CHECKPOINT_KEY = "cloud-moneydj-fund:ROLLING";
// 2026-10-08: confirmed in Production that no CLOUD_MONEYDJ_FUND run has EVER reached COMPLETED —
// every invocation is left permanently IN_PROGRESS with attempted=0, because run stats are only
// written once by finishRun() at the very end of the loop (same gap as the cloud-etf-price hang
// fixed in d800f8097), and a 200-fund batch cannot reliably finish inside maxDuration=300s: the
// nextCodes() lookup alone measured ~12.5s, leaving an unrealistic per-item budget for 200 real
// MoneyDJ fetch+parse+persist calls (each already individually timeout-protected at 30s). Lowered
// to a batch size this window can realistically complete start-to-finish; no change to the fetch,
// parse, persist, checkpoint or backoff logic itself.
// Task X11 (round-6 daily-completion audit): raised to the already-proven-safe ceiling (MAX_BATCH)
// -- at the old DEFAULT_BATCH=50, hourly x 24/day = 1,200/day against a ~5,633-fund candidate pool
// (fund_mappings WHERE moneydj_code IS NOT NULL) took ~5 days for one full cursor pass. At 80,
// hourly x 24/day = 1,920/day, ~3 days per pass -- still not same-day, but the cursor itself still
// wraps and wasn't newly broken. Going further would mean either exceeding this route's own
// empirically-proven 300s-maxDuration safe batch ceiling (see the 2026-10-08 comment above) or
// increasing the GitHub Actions schedule frequency, which raises MoneyDJ scrape volume -- left as a
// flagged tradeoff rather than silently cranking it up, per the standing anti-scraping-abuse rule.
const DEFAULT_BATCH = 80;
const MAX_BATCH = 80;
const FRESH_DAYS = 25; // matches the local disclosure worker's re-fetch guard
// 2026-10-08: the real fix for "every run stuck IN_PROGRESS" is a time budget, not just a smaller
// batch cap — a smaller batch only lowers the odds of running out of time, it doesn't guarantee a
// checkpoint gets written before Vercel's hard maxDuration kill. Same margin convention as
// yahoo-etf-full-sweep (TIME_BUDGET_MS well under maxDuration=300s so a checkpoint write always
// happens). Not a maxDuration increase — maxDuration stays 300.
const TIME_BUDGET_MS = 240_000;

// 2026-10-19: hourBucketKey() (lib/cloud-ingestion/runContext.ts) dedups run_key per CALENDAR HOUR,
// shared by 9 other cron routes that genuinely want "at most once per hour" semantics. This route no
// longer does — the daily-completion fix now fires GitHub Actions 4x/hour (:02/:22/:37/:52) plus
// Vercel's native */20 cron (:00/:20/:40), specifically so this job gets more real attempts per day.
// Under hourBucketKey, every one of those extra triggers within the same hour would hit the same
// run_key and be skipped ("run_key already present this hour") the instant the hour's first trigger
// succeeds -- making the added trigger frequency a no-op for actual throughput. quarterHourBucketKey
// buckets by 15-minute window instead (:00/:15/:30/:45), giving up to 4 distinct, independently-
// dedup'd run_key slots per hour. A single run takes ~243-250s (TIME_BUDGET_MS=240_000 + response
// overhead), comfortably inside one 900s-wide bucket with no risk of spilling into the next bucket's
// window. Scoped to this route only -- NOT a change to the shared hourBucketKey used by the other 9
// routes, which still want hourly dedup.
function quarterHourBucketKey(prefix: string, now = new Date()): string {
  const hourPrefix = now.toISOString().slice(0, 13); // e.g. 2026-10-19T05
  const quarter = String(Math.floor(now.getUTCMinutes() / 15) * 15).padStart(2, "0"); // 00/15/30/45
  return `${prefix}:${hourPrefix}:${quarter}`;
}

// portfolioKey = fund_share_classes.master_fund_id when that mapping is verifiable (an actual row
// links this fund to a master), otherwise the fund's own id — i.e. the SAME master-fund identity
// already established and tested in f48d8e25a/8b83d4a27, never a name-similarity guess made here.
// fundId stays the representative Yahoo/MoneyDJ-identified fund actually fetched for this portfolio.
type MappedFund = { fundId: string; moneydjCode: string; canonicalName: string; portfolioKey: string };

export type MoneydjBatchOutcome = {
  attempted: number;
  updatedFunds: number;
  rowsPersisted: number;
  failed: number;
  retryable: number;
  http403: number;
  http429: number;
  alreadyCurrent: number;
  backoffStop: boolean;
  timeBudgetStop: boolean;
  failures: Array<{ code: string; reason: string }>;
  lastId: string;
};

// Pure-ish loop (only effects are the two injected callbacks) extracted so the time-budget /
// per-item-checkpoint contract can be tested directly, without a live DB or network call: given a
// `now` that reports elapsed time past the budget partway through, and a `processOne` that resolves
// instantly, the test asserts onProgress fires after every reached item (not just once at the end)
// and the loop stops — with `lastId` pointing at the right resume point — exactly at the budget.
export async function runMoneydjBatch(
  codes: MappedFund[],
  opts: {
    cursor: string;
    startedMs: number;
    timeBudgetMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    processOne: (fund: MappedFund) => Promise<{ rowsPersisted: number; isNewMonth: boolean }>;
    onProgress: (lastId: string, counters: { attempted: number; updatedFunds: number; failed: number }) => Promise<void>;
  },
): Promise<MoneydjBatchOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let attempted = 0;
  let updatedFunds = 0;
  let rowsPersisted = 0;
  let failed = 0;
  let retryable = 0;
  let http403 = 0;
  let http429 = 0;
  let alreadyCurrent = 0;
  let backoffStop = false;
  let timeBudgetStop = false;
  const failures: Array<{ code: string; reason: string }> = [];
  let lastId = opts.cursor;

  for (const fund of codes) {
    if (now() - opts.startedMs > opts.timeBudgetMs) {
      timeBudgetStop = true;
      break;
    }
    lastId = fund.portfolioKey; // cursor advances by master-fund portfolio, not by individual share class
    attempted++;
    try {
      const result = await opts.processOne(fund);
      rowsPersisted += result.rowsPersisted;
      if (result.isNewMonth) updatedFunds++;
      else alreadyCurrent++;
    } catch (error) {
      if (error instanceof MoneydjHttpError) {
        if (error.httpStatus === 403) http403++;
        else http429++;
        failed++;
        retryable++;
        failures.push({ code: fund.moneydjCode, reason: `HTTP_${error.httpStatus}` });
        await opts.onProgress(lastId, { attempted, updatedFunds, failed });
        // bounded backoff: one short pause, then stop the batch (no aggressive retry)
        await sleep(2_000);
        backoffStop = true;
        break;
      }
      failed++;
      const message = String(error).slice(0, 300);
      if (/READBACK_FAILED|SINGLE_WRITER_LOCKED/.test(message)) retryable++;
      failures.push({ code: fund.moneydjCode, reason: message });
    }
    // Progress checkpoint after every fund we reached, success or non-backoff failure alike — the
    // cursor only ever needs to mean "everything up to and including this id has been attempted."
    // This is what makes a fund already successfully processed safe from re-fetch/re-write even if
    // this invocation is hard-killed immediately after: onProgress, not the run's final return, is
    // what the next invocation's readCheckpoint() actually resumes from.
    await opts.onProgress(lastId, { attempted, updatedFunds, failed });
  }

  return { attempted, updatedFunds, rowsPersisted, failed, retryable, http403, http429, alreadyCurrent, backoffStop, timeBudgetStop, failures, lastId };
}

// 2026-10-22（使用者核准，共用資料庫負載第二項）: 批次刷新版本——跟runMoneydjBatch共用同一套
// fetch/錯誤處理/time-budget/backoff邏輯，差別只在「抓到的disclosure先放進buffer，累積到
// innerBatchSize或遇到backoff/time-budget/迴圈結束才一次性呼叫persistBatch」，讓多檔的holdings
// 寫入包進同一個transaction（見persistMoneydjDisclosureBatch），減少refresh_reverse_products的
// 觸發次數。name-only揭露（fund_holdings_name_only）不受影響，持續逐檔立即寫入（那張表沒有
// holdings的trigger鏈問題）。
export async function runMoneydjBatchGrouped(
  codes: MappedFund[],
  opts: {
    cursor: string;
    startedMs: number;
    timeBudgetMs: number;
    innerBatchSize: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    fetchOne: (fund: MappedFund) => Promise<{ disclosure: import("@/lib/cloud-ingestion/moneydjFundDisclosure").MoneydjDisclosure } | { nameOnly: { rowsPersisted: number } }>;
    persistBatch: (
      items: Array<{ fund: MappedFund; disclosure: import("@/lib/cloud-ingestion/moneydjFundDisclosure").MoneydjDisclosure }>,
    ) => Promise<Array<{ fundId: string; rowsPersisted: number; isNewMonth: boolean }>>;
    onProgress: (lastId: string, counters: { attempted: number; updatedFunds: number; failed: number }) => Promise<void>;
  },
): Promise<MoneydjBatchOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let attempted = 0, updatedFunds = 0, rowsPersisted = 0, failed = 0, retryable = 0;
  let http403 = 0, http429 = 0, alreadyCurrent = 0;
  let backoffStop = false, timeBudgetStop = false;
  const failures: Array<{ code: string; reason: string }> = [];
  let lastId = opts.cursor;
  let buffer: Array<{ fund: MappedFund; disclosure: import("@/lib/cloud-ingestion/moneydjFundDisclosure").MoneydjDisclosure }> = [];
  let bufferLastId = lastId;

  const flush = async () => {
    if (buffer.length === 0) return;
    const results = await opts.persistBatch(buffer);
    const byFund = new Map(results.map((r) => [r.fundId, r]));
    for (const item of buffer) {
      const r = byFund.get(item.fund.fundId);
      if (r) {
        rowsPersisted += r.rowsPersisted;
        if (r.isNewMonth) updatedFunds++;
        else alreadyCurrent++;
      }
    }
    buffer = [];
    await opts.onProgress(bufferLastId, { attempted, updatedFunds, failed });
  };

  for (const fund of codes) {
    if (now() - opts.startedMs > opts.timeBudgetMs) { timeBudgetStop = true; break; }
    lastId = fund.portfolioKey;
    attempted++;
    try {
      const result = await opts.fetchOne(fund);
      if ("nameOnly" in result) {
        rowsPersisted += result.nameOnly.rowsPersisted;
        updatedFunds++; // 沿用原本把name-only disclosure算成已處理(isNewMonth=true)的慣例
      } else {
        buffer.push({ fund, disclosure: result.disclosure });
        bufferLastId = lastId;
        if (buffer.length >= opts.innerBatchSize) await flush();
      }
    } catch (error) {
      if (error instanceof MoneydjHttpError) {
        if (error.httpStatus === 403) http403++; else http429++;
        failed++; retryable++;
        failures.push({ code: fund.moneydjCode, reason: `HTTP_${error.httpStatus}` });
        await flush();
        await opts.onProgress(lastId, { attempted, updatedFunds, failed });
        await sleep(2_000);
        backoffStop = true;
        break;
      }
      failed++;
      const message = String(error).slice(0, 300);
      if (/READBACK_FAILED|SINGLE_WRITER_LOCKED/.test(message)) retryable++;
      failures.push({ code: fund.moneydjCode, reason: message });
    }
    await opts.onProgress(lastId, { attempted, updatedFunds, failed });
  }
  await flush();

  return { attempted, updatedFunds, rowsPersisted, failed, retryable, http403, http429, alreadyCurrent, backoffStop, timeBudgetStop, failures, lastId };
}

// 2026-10-08: dedup by master fund. A master's share classes all disclose the SAME underlying
// portfolio (that's the whole point of f48d8e25a/8b83d4a27's master-fund model) — fetching and
// writing MoneyDJ holdings separately for every share class was pure waste, since
// lib/data-platform/reverseHoldings.ts already groups by master_fund_id at READ time and serves
// whichever share class actually has the data to all of them. The grouping key here is exactly
// fund_share_classes.master_fund_id — never a name-similarity guess — and a fund with no verified
// master mapping (no fund_share_classes row) is its own standalone portfolio, unchanged from before.
//
// Freshness cutoff: 每月8-15日 the official disclosure window is checked tightly — only this
// calendar month's data counts as fresh, forcing a re-check of anything still showing last month's
// filing. Outside that window the existing FRESH_DAYS rolling check remains as the 補查 backstop for
// funds that published late (so a fund that didn't have its report out by the 15th still gets
// picked up once FRESH_DAYS elapses, not forgotten).
export function freshnessCutoffDate(now: Date = new Date()): string {
  const taipeiMs = now.getTime() + 8 * 60 * 60 * 1000; // Asia/Taipei, no DST
  const t = new Date(taipeiMs);
  const day = t.getUTCDate();
  if (day >= 8 && day <= 15) {
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)).toISOString().slice(0, 10);
  }
  return new Date(now.getTime() - FRESH_DAYS * 86_400_000).toISOString().slice(0, 10);
}

async function nextCodes(cursor: string, batch: number): Promise<MappedFund[]> {
  return prisma.$queryRawUnsafe<MappedFund[]>(
    `WITH candidates AS (
       SELECT f.id AS fund_id, m.moneydj_code, f.name AS canonical_name,
              COALESCE(sc.master_fund_id, f.id) AS portfolio_key
         FROM fund_mappings m
         JOIN funds f ON f.id = m.fund_id
         LEFT JOIN fund_share_classes sc ON sc.fund_id = f.id
        WHERE m.moneydj_code IS NOT NULL
          -- 2026-10-19（使用者商品範圍規則，最高層）: 只更新「台灣買得到」的核心母體基金，
          -- 不再抓非核心基金的揭露持股（這也是 MONEYDJ_DISCLOSED_HOLDINGS_MISSING 健康報告
          -- 異常的主要來源——多數失敗的 fund_id 本身就不是核心母體）。
          AND f.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED')
     ),
     fresh_portfolios AS (
       SELECT DISTINCT COALESCE(sc.master_fund_id, h.fund_id) AS portfolio_key
         FROM holdings h
         LEFT JOIN fund_share_classes sc ON sc.fund_id = h.fund_id
        WHERE h.asset_type = 'FUND' AND h.source = $2 AND h.as_of_date >= $3::date
     ),
     picked AS (
       SELECT DISTINCT ON (c.portfolio_key) c.fund_id, c.moneydj_code, c.canonical_name, c.portfolio_key
         FROM candidates c
        WHERE c.portfolio_key > $1
          AND c.portfolio_key NOT IN (SELECT portfolio_key FROM fresh_portfolios)
        ORDER BY c.portfolio_key, c.fund_id
     )
     SELECT fund_id AS "fundId", moneydj_code AS "moneydjCode", canonical_name AS "canonicalName",
            portfolio_key AS "portfolioKey"
       FROM picked
      ORDER BY portfolio_key
      LIMIT $4`,
    cursor,
    MONEYDJ_SOURCE,
    freshnessCutoffDate(),
    batch,
  );
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const url = new URL(request.url);
  const batch = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get("batch") ?? DEFAULT_BATCH)));
  const startedMs = Date.now();

  const universeRows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM fund_mappings m JOIN funds f ON f.id = m.fund_id
      WHERE m.moneydj_code IS NOT NULL
        AND f.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED')`,
  );
  const universeCount = Number(universeRows[0]?.n ?? 0);

  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = quarterHourBucketKey("cloud-moneydj-fund");
  const { runId, skipped } = await beginRun({
    jobName: JOB,
    provider: PROVIDER,
    runKey,
    universeCount,
    batchSize: batch,
    checkpointBefore: before,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this 15-minute window", runKey });
  }

  let cursor = before?.lastSymbol ?? "";
  let wrapped = false;
  let codes = await nextCodes(cursor, batch);
  if (codes.length === 0 && cursor !== "") {
    wrapped = true;
    cursor = "";
    codes = await nextCodes(cursor, batch);
  }

  // 2026-10-22（使用者核准，共用資料庫負載第二項）: 預設(開關關閉)維持原本逐檔各自commit的
  // runMoneydjBatch，行為完全不變。開關開了才走runMoneydjBatchGrouped，把holdings寫入包成
  // MONEYDJ_FUND_BATCH_REFRESH_INNER_SIZE檔一個transaction。
  const batchRefreshEnabled = isMoneydjFundBatchRefreshEnabled();
  const innerBatchSize = moneydjFundBatchRefreshInnerSize();

  const outcome = batchRefreshEnabled
    ? await runMoneydjBatchGrouped(codes, {
        cursor,
        startedMs,
        timeBudgetMs: TIME_BUDGET_MS,
        innerBatchSize,
        fetchOne: async (fund) => {
          try {
            const disclosure = await fetchMoneydjDisclosure(fund.moneydjCode);
            return { disclosure };
          } catch (error) {
            if (error instanceof MoneydjHoldingsNameOnlyError) {
              const { rowsPersisted } = await persistNameOnlyHoldings(prisma, {
                fundId: fund.fundId, moneydjCode: fund.moneydjCode, date: error.date, names: error.names,
              });
              return { nameOnly: { rowsPersisted } };
            }
            throw error;
          }
        },
        persistBatch: (items) =>
          persistMoneydjDisclosureBatch(
            prisma,
            items.map(({ fund, disclosure }) => ({ fundId: fund.fundId, shareClassId: null, moneydjCode: fund.moneydjCode, disclosure })),
          ),
        onProgress: (lastSymbol, counters) =>
          writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
            lastSymbol,
            processed: (before?.processed ?? 0) + counters.attempted,
            succeeded: (before?.succeeded ?? 0) + counters.updatedFunds,
            failed: (before?.failed ?? 0) + counters.failed,
          }),
      })
    : await runMoneydjBatch(codes, {
        cursor,
        startedMs,
        timeBudgetMs: TIME_BUDGET_MS,
        processOne: (fund) =>
          fetchMoneydjDisclosure(fund.moneydjCode)
            .then((disclosure) =>
              persistMoneydjDisclosure(prisma, { fundId: fund.fundId, shareClassId: null, moneydjCode: fund.moneydjCode, disclosure }),
            )
            .catch(async (error) => {
              // Names-only disclosure (no weight at all) is a known, recognized page shape, not a
              // parse failure -- persist to its own dedicated table (never `holdings`, see
              // persistNameOnlyHoldings's own doc comment) and count it as handled, same as a normal
              // successful disclosure, instead of leaving it stuck in the generic failed/retry bucket.
              if (error instanceof MoneydjHoldingsNameOnlyError) {
                const { rowsPersisted } = await persistNameOnlyHoldings(prisma, {
                  fundId: fund.fundId, moneydjCode: fund.moneydjCode, date: error.date, names: error.names,
                });
                return { rowsPersisted, isNewMonth: true };
              }
              throw error;
            }),
        onProgress: (lastSymbol, counters) =>
          writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
            lastSymbol,
            processed: (before?.processed ?? 0) + counters.attempted,
            succeeded: (before?.succeeded ?? 0) + counters.updatedFunds,
            failed: (before?.failed ?? 0) + counters.failed,
          }),
      });
  const {
    attempted,
    updatedFunds,
    rowsPersisted,
    failed,
    retryable,
    http403,
    http429,
    alreadyCurrent,
    backoffStop,
    timeBudgetStop,
    failures,
    lastId,
  } = outcome;

  // Advance cursor to the last code we *reached*. If we stopped on backoff or the time budget, keep
  // the cursor there so the next run resumes from the same place. If the window was short, we hit
  // the tail -> wrap.
  const reachedEnd = !backoffStop && !timeBudgetStop && codes.length < batch;
  const nextCursor = reachedEnd ? "" : lastId;
  const after: CheckpointRow = {
    lastSymbol: nextCursor,
    processed: (before?.processed ?? 0) + attempted,
    succeeded: (before?.succeeded ?? 0) + updatedFunds,
    failed: (before?.failed ?? 0) + failed,
    updatedAt: new Date().toISOString(),
  };
  // Final write: same shape as saveProgress, but also resolves reachedEnd's wrap-to-start case,
  // which saveProgress (called mid-loop, before that's known) can't express.
  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: nextCursor,
    processed: after.processed,
    succeeded: after.succeeded,
    failed: after.failed,
  });

  const status =
    backoffStop || timeBudgetStop || (failed > 0 && updatedFunds === 0 && rowsPersisted === 0) ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status,
    attempted,
    completed: attempted - failed,
    inserted: rowsPersisted,
    updated: updatedFunds,
    failed,
    retryableFailures: retryable,
    checkpointAfter: after,
    error: failures.length ? `${failures.length} failures; e.g. ${failures[0]?.reason}` : null,
    details: {
      checkpoint_before: before,
      batch_size: batch,
      wrapped,
      reached_end: reachedEnd,
      backoff_stop: backoffStop,
      time_budget_stop: timeBudgetStop,
      time_budget_ms: TIME_BUDGET_MS,
      window_size: codes.length,
      already_current: alreadyCurrent,
      http_403: http403,
      http_429: http429,
      http_5xx: 0,
      master_fund_dedup: true,
      sample_failures: failures.slice(0, 5),
    },
  });

  return Response.json({
    ok: true,
    job: JOB,
    runId,
    httpStatus: 200,
    checked: attempted,
    updated: updatedFunds,
    holdingRowsPersisted: rowsPersisted,
    alreadyCurrent,
    failed,
    retryableFailures: retryable,
    http403,
    http429,
    backoffStop,
    timeBudgetStop,
    checkpointBefore: before?.lastSymbol ?? null,
    checkpointAfter: nextCursor || "(wrapped to start)",
    wrapped,
    reachedEnd,
    universeCount,
    runtimeMs: Date.now() - startedMs,
    status,
    masterFundDedup: true,
  });
}
