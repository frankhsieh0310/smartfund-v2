// Domestic + offshore fund period-return sync, sourced from Yahoo奇摩's own fund "績效表現" page
// (lib/yahoo/fundPerformancePage.ts) instead of being self-computed from NAV history -- same
// "照抄 Yahoo奇摩顯示的數值" rule already applied to TW ETFs (etf-returns-sync) and TW ETF day-change
// (tw-etf-day-change). Reuses the SAME two mapping sources as holdings-alt-source-sync (offshore-nav-
// sync's offshore-nav-sync:yahoo-mapping checkpoint + fund_provider_mappings for domestic), since both
// already resolve fundId -> yahooFundId correctly -- no new discovery sweep needed.
//
// SHADOW MODE BY DEFAULT: unless FUND_RETURNS_SYNC_WRITE is exactly "on", fetches and classifies but
// writes nothing -- same pattern as every other sync job in this codebase. Manually cross-checked
// (shadow mode, browser) against 20 funds (15 domestic + 5 offshore) 2026-10-14: 20/20 exact match
// against the live page at request time (see docs/specs/fund-returns-shadow-verification.md).
//
// Writes fund_performances (fundId, date) -- a table nothing else currently populates for these
// domestic/offshore funds (checked: no other route/script inserts into fund_performances), so there
// is no column-ownership conflict to manage here, unlike etf_performances.
//
// Scheduled hourly at :41 (vercel.json) -- user-approved round-4 instruction: 150s time budget per
// invocation, >=3s request spacing, round-robin via the existing cursor (already-processed codes sort
// to the end via `code > afterCode`; wraps to the start once a full pass completes).
import { prisma } from "@/lib/prisma";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { loadMapping } from "@/lib/offshore-nav-sync/mapping";
import { loadDomesticYahooMapping } from "@/lib/holdings-alt-source/domesticYahooMapping";
import { fetchYahooFundPerformance, YahooFundRateLimitedError } from "@/lib/yahoo/fundPerformancePage";
import { loadExchangeCalendarRegistry } from "@/lib/market-close-sync/marketConfig";
import { mostRecentTradingDay } from "@/lib/market-close-sync/marketTime";
import { findBackfillCandidates, runMappingBackfillBatch, writeMatchedMappings } from "@/lib/holdings-alt-source/domesticYahooMappingBackfill";
import { isFundYahooMappingBackfillWriteEnabled } from "@/lib/cron/fundYahooMappingBackfillWriteGate";

export const runtime = "nodejs";
export const maxDuration = 290;
export const dynamic = "force-dynamic";

const JOB = "FUND_RETURNS_SYNC";
const CHECKPOINT_KEY = "fund-returns-sync:cursor";
const REQUEST_DELAY_MS = 3_200;
// Raised from 150s to 270s this round (audit found the 2,168-fund universe was taking ~4 days/pass
// at the old budget + hourly cadence): maxDuration=290s gives 20s margin. REQUEST_DELAY_MS is left
// untouched — that's the anti-scraping-pace rule, not the lever to pull.
// 2026-10-29（使用者核准，再加快一輪）: universe已經長到2489檔；VERIFIED過去5天(27次執行)
// http_429一直是0，有餘裕。改成frequency而不是REQUEST_DELAY_MS這個唯一安全的加速槓桿——
// vercel.json從每小時2次(:11/:41)改成每小時3次(:01/:21/:41)，單次請求節奏完全不變，
// 只是一天內多跑約50%次數，不會提高被429的風險。
// 2026-10-30（使用者核准，併進這支既有排程而不是新增cron——vercel.json已經接近100個cron entry的
// 上限）: 原本270_000讓出一塊固定預算給下面的mapping backfill步驟(BACKFILL_TIME_BUDGET_MS)，
// 兩段合計(230s+40s=270s)還在maxDuration=290s內留20s margin，跟原本單純returns-sync那段的
// margin邏輯一致。
const TIME_BUDGET_MS = 230_000;
const BACKFILL_TIME_BUDGET_MS = 40_000;
const BACKFILL_REQUEST_SPACING_MS = 3_000;
const BACKFILL_CHECKPOINT_KEY = "fund-yahoo-mapping-backfill:cursor";
const query = (sql: string, params: any[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);
const execute = (sql: string, params: any[]) => prisma.$executeRawUnsafe(sql, ...params);

function isWriteEnabled(): boolean {
  return process.env.FUND_RETURNS_SYNC_WRITE?.trim() === "on";
}

// 2026-10-30（使用者核准）: mapping backfill打外部Yahoo search API，避開台北01:00-05:30
// （=UTC 17:00-21:30，台灣沒有日光節約時間，固定offset換算）——沿用CLAUDE.md「資料庫維護窗口」
// 同一個避開時段的慣例，不是這支pipeline自己發明的規則。returns-sync本身（讀既有mapping，不打
// 新的外部搜尋）不受這個限制，只有backfill這個新增的搜尋步驟跳過這個時段。
function isWithinMappingBackfillBlackout(now: Date): boolean {
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const minutesOfDay = utcH * 60 + utcM;
  return minutesOfDay >= 17 * 60 && minutesOfDay <= 21 * 60 + 30;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabled = isWriteEnabled();
  // 2026-10-18 root-cause fix: previously wrote `today` (execution day) directly as the `date`
  // column, including on weekends (this route runs hourly, no weekday restriction) -- VERIFIED this
  // stamped non-trading-day dates onto real performance figures. These are TW-focused domestic +
  // offshore fund pages (Yahoo奇摩), so the TWSE calendar is the right one: reuse the exact registry
  // market-close-sync already maintains (config/production-yahoo-daily-jobs.json) rather than
  // inventing a second calendar.
  const registry = await loadExchangeCalendarRegistry();
  const twseJob = registry.jobs.find((j) => j.id === "twse-yahoo-daily")!;
  const today = mostRecentTradingDay(twseJob, new Date().toISOString().slice(0, 10));

  // 2026-10-29（使用者核准，FUND_RETURNS_SYNC頻率從每天48次掉到每天1次的根因修正）: VERIFIED
  // production_scheduler_checkpoints.last_symbol卡在空字串""——這週discoverNewMappings新找到的
  // 境外基金mapping裡，有200多筆offshore-nav-sync:yahoo-mapping checkpoint的entry只解析出
  // yahooFundId、沒有code（VERIFIED combined排序後最前面連續200+筆都是code===""）。原本用
  // entry.code當游標：這批code===""的entry把每次呼叫的前~78筆全部佔滿，lastCode最後存成""，
  // 下一次呼叫的`afterCode ? ... : 0`把空字串當成falsy、游標永遠被重置回最前面——同一批
  // code===""的基金被無限重抓，從未真正往後推進，當天剩下的47次呼叫因為run_key
  // (JOB:today:afterCode)完全沒變而被beginRun當成重複直接skip，直到隔天today换了才能再跑一次
  // （一樣卡在同一批、同一個結果）。改成用yahooFundId當排序/游標鍵——每筆entry一定有
  // yahooFundId（不可能是空字串），行為不變（DB寫入本來就用entry.fundId，不是code），
  // 只是讓游標能真正往後推進，不再卡死。
  const [offshoreMapping, domesticMapping] = await Promise.all([loadMapping(query), loadDomesticYahooMapping(query)]);
  const combined = [...offshoreMapping, ...domesticMapping].sort((a, b) => a.yahooFundId.localeCompare(b.yahooFundId));

  const checkpoint = await readCheckpoint(CHECKPOINT_KEY);
  const afterCode = checkpoint?.lastSymbol ?? null;
  const startIndex = afterCode ? combined.findIndex((m) => m.yahooFundId > afterCode) : 0;
  const batch = startIndex === -1 ? [] : combined.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + 200);

  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_FUND_PERFORMANCE_PAGE", runKey: `${JOB}:${today}:${afterCode ?? "start"}`,
    universeCount: combined.length, batchSize: batch.length, checkpointBefore: checkpoint,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey: afterCode });

  let attempted = 0, written = 0, noData = 0, failed = 0;
  let lastCode: string | null = afterCode;
  let rateLimitStop = false;
  let timeBudgetStop = false;

  for (const entry of batch) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    attempted++;
    try {
      const perf = await fetchYahooFundPerformance(entry.yahooFundId);
      if (perf) {
        if (writeEnabled) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO fund_performances (id, fund_id, date, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y, return_10y, created_at)
             VALUES (gen_random_uuid()::text, $1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
             ON CONFLICT (fund_id, date) DO UPDATE SET
               return_1m = EXCLUDED.return_1m, return_3m = EXCLUDED.return_3m, return_6m = EXCLUDED.return_6m,
               return_ytd = EXCLUDED.return_ytd, return_1y = EXCLUDED.return_1y, return_3y = EXCLUDED.return_3y,
               return_5y = EXCLUDED.return_5y, return_10y = EXCLUDED.return_10y`,
            entry.fundId, today, perf.m1, perf.m3, perf.m6, perf.ytd, perf.y1, perf.y3, perf.y5, perf.y10,
          );
        }
        written++;
      } else {
        noData++;
      }
    } catch (e) {
      if (e instanceof YahooFundRateLimitedError) { rateLimitStop = true; break; }
      failed++;
    }
    lastCode = entry.yahooFundId;
    await sleep(REQUEST_DELAY_MS);
  }

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: rateLimitStop || timeBudgetStop || batch.length === 200 ? lastCode : null, // null = wrap to start next time
    processed: attempted, succeeded: written, failed: noData + failed,
  });

  // 2026-10-22（使用者核准，三.三稽核發現）: 之前failed>0但沒觸發rate/time限制時，就算written=0
  // 也還是COMPLETED。
  const status = rateLimitStop || timeBudgetStop ? "PARTIAL" : writeEnabled && attempted > 0 && written === 0 ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, "YAHOO_FUND_PERFORMANCE_PAGE", startedMs, {
    status, attempted, completed: written, inserted: written, updated: 0, failed: noData + failed, retryableFailures: 0,
    checkpointAfter: null,
    details: { writeEnabled, rateLimitStop, timeBudgetStop, lastCode, universeCount: combined.length },
  });

  // 2026-10-30（使用者核准）: 基金期間報酬率大量UNAVAILABLE的根因修復——見
  // lib/holdings-alt-source/domesticYahooMappingBackfill.ts頂部說明。併進這支既有排程（不新增
  // cron），用上面讓出的固定小預算跑一批，游標接續，遇429/403立刻整批停止等下一輪。
  const backfillJob = "FUND_YAHOO_MAPPING_BACKFILL";
  const backfillWriteEnabled = isFundYahooMappingBackfillWriteEnabled();
  let backfillResult: Record<string, unknown> = { skipped: true, reason: "BLACKOUT_WINDOW" };
  if (!isWithinMappingBackfillBlackout(new Date())) {
    const backfillCheckpoint = await readCheckpoint(BACKFILL_CHECKPOINT_KEY);
    const backfillAfterId = backfillCheckpoint?.lastSymbol ?? null;
    const maxCandidates = Math.ceil(BACKFILL_TIME_BUDGET_MS / BACKFILL_REQUEST_SPACING_MS);
    let candidates = await findBackfillCandidates(query, backfillAfterId, maxCandidates);
    let wrapped = false;
    if (candidates.length === 0 && backfillAfterId !== null) {
      // cursor reached the end of this pass -- wrap to the start, same convention as fund-returns-sync's own cursor above.
      candidates = await findBackfillCandidates(query, null, maxCandidates);
      wrapped = true;
    }
    const { runId: backfillRunId, skipped: backfillSkipped } = await beginRun({
      jobName: backfillJob, provider: "YAHOO_TW_FUND_SEARCH", runKey: `${backfillJob}:${new Date().toISOString().slice(0, 13)}`,
      universeCount: 0, batchSize: candidates.length, checkpointBefore: backfillCheckpoint,
    });
    if (!backfillSkipped) {
      const { outcomes, rateLimitStop: backfillRateLimitStop, lastAttemptedFundId } = await runMappingBackfillBatch(candidates, BACKFILL_REQUEST_SPACING_MS);
      const matched = outcomes.filter((o) => o.result === "MATCHED");
      const written2 = backfillWriteEnabled ? await writeMatchedMappings(execute, outcomes) : 0;
      await writeCheckpoint(backfillJob, BACKFILL_CHECKPOINT_KEY, backfillRunId, {
        lastSymbol: wrapped && outcomes.length === 0 ? null : lastAttemptedFundId,
        processed: (backfillCheckpoint?.processed ?? 0) + outcomes.length,
        succeeded: (backfillCheckpoint?.succeeded ?? 0) + matched.length,
        failed: outcomes.length - matched.length,
      });
      await finishRun(backfillRunId, backfillJob, "YAHOO_TW_FUND_SEARCH", Date.now(), {
        status: backfillRateLimitStop ? "PARTIAL" : "COMPLETED",
        attempted: outcomes.length, completed: matched.length, inserted: written2, updated: 0,
        failed: outcomes.length - matched.length, retryableFailures: backfillRateLimitStop ? 1 : 0,
        checkpointAfter: null,
        details: { writeEnabled: backfillWriteEnabled, rateLimitStop: backfillRateLimitStop, wrapped, outcomes: outcomes.slice(0, 50) },
      });
      backfillResult = { attempted: outcomes.length, matched: matched.length, written: written2, writeEnabled: backfillWriteEnabled, rateLimitStop: backfillRateLimitStop, wrapped };
    } else {
      backfillResult = { skipped: true, reason: "DUPLICATE_RUN_KEY" };
    }
  }

  return Response.json({ ok: true, job: JOB, runId, status, attempted, written, noData, failed, writeEnabled, lastCode, universeCount: combined.length, mappingBackfill: backfillResult });
}
