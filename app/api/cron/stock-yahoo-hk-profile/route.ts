// 2026-11-08（使用者第36輪指令第三點核准）: 全部台股上市櫃個股的52週區間／市值（雅虎財經香港站）
// 跟公司簡介（證交所MOPS「主要經營業務」）。52週/市值每個交易日跑一次；公司簡介每個月跑一次
// （用 company_profile_as_of_date 判斷超過25天才重抓，避免每天重複打同一個官方頁面）。
// 抓取禮貌：每檔間隔至少1秒、遇到401/403/429整個invocation立刻停止（不重試、不換頭換身分）、
// 凌晨01:00-05:30台北時間不跑。時間箱＋checkpoint游標，單次invocation處理有限檔數，跟
// etf-official-holdings同一種節奏。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint, type CheckpointRow } from "@/lib/cloud-ingestion/runContext";
import { fetchYahooHkRangeCap, fetchTwseCompanyProfile, inForbiddenWindowTaipei } from "@/lib/data-platform/web/stockYahooHkProfile";

export const runtime = "nodejs";
export const maxDuration = 290;
export const dynamic = "force-dynamic";

const JOB = "STOCK_YAHOO_HK_PROFILE";
const CHECKPOINT_KEY = "stock-yahoo-hk-profile:daily-cursor";
const HARD_DEADLINE_MS = 260_000;
const MIN_REMAINING_TO_START_MS = 5_000;
const REQUEST_DELAY_MS = 1_000; // 每檔至少間隔1秒
const PROFILE_REFRESH_DAYS = 25; // 公司簡介每月更新一次，超過25天才重抓

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function todayTaipeiKey(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function taipeiDateKey(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  if (inForbiddenWindowTaipei()) {
    return Response.json({ ok: false, job: JOB, skipped: true, reason: "FORBIDDEN_WINDOW_01_0530_TAIPEI" });
  }

  const startedMs = Date.now();
  const stocks = await prisma.stock.findMany({
    where: { isActive: true, exchange: { in: ["TWSE", "TPEx", "TPEX"] } },
    orderBy: { ticker: "asc" },
    select: { id: true, ticker: true, yahooSymbol: true },
  });

  const storedCheckpoint = await readCheckpoint(CHECKPOINT_KEY);
  const isFromToday = taipeiDateKey(storedCheckpoint?.updatedAt ?? null) === todayTaipeiKey();
  const effectiveCheckpoint: CheckpointRow | null = isFromToday ? storedCheckpoint : null;
  const startIndex = effectiveCheckpoint?.lastSymbol ? stocks.findIndex((s) => s.ticker === effectiveCheckpoint.lastSymbol) + 1 : 0;

  const runKey = `${JOB}:${todayTaipeiKey()}:starting-at-${Math.max(startIndex, 0)}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_HK_FINANCE+TWSE_MOPS", runKey,
    universeCount: stocks.length, batchSize: stocks.length - Math.max(startIndex, 0), checkpointBefore: effectiveCheckpoint,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "double trigger", runKey });

  let processed = 0, succeeded = 0, failed = 0, blocked = false, blockedHttpStatus: number | null = null;
  let lastProcessedTicker: string | null = effectiveCheckpoint?.lastSymbol ?? null;
  let index = Math.max(startIndex, 0);
  const todayDate = todayTaipeiKey();

  for (; index < stocks.length; index++) {
    const elapsed = Date.now() - startedMs;
    if (HARD_DEADLINE_MS - elapsed < MIN_REMAINING_TO_START_MS) break;
    const stock = stocks[index];
    processed++;
    try {
      const rangeCap = await fetchYahooHkRangeCap(stock.yahooSymbol);
      if (rangeCap.status === "BLOCKED") { blocked = true; blockedHttpStatus = rangeCap.httpStatus; break; }

      const existing = await prisma.$queryRawUnsafe<Array<{ company_profile_as_of_date: Date | null }>>(
        `SELECT company_profile_as_of_date FROM stock_yahoo_hk_profile WHERE stock_id = $1`, stock.id,
      );
      const profileAge = existing[0]?.company_profile_as_of_date
        ? (Date.now() - new Date(existing[0].company_profile_as_of_date).getTime()) / 86_400_000
        : Infinity;
      let profileText: string | null = null;
      let profileFetched = false;
      if (profileAge > PROFILE_REFRESH_DAYS) {
        await sleep(REQUEST_DELAY_MS);
        const profile = await fetchTwseCompanyProfile(stock.ticker);
        if (profile.status === "BLOCKED") { blocked = true; blockedHttpStatus = profile.httpStatus; break; }
        if (profile.status === "OK") { profileText = profile.data; profileFetched = true; }
      }

      if (rangeCap.status === "OK") {
        await prisma.$executeRawUnsafe(
          `INSERT INTO stock_yahoo_hk_profile (stock_id, week52_low, week52_high, week52_as_of_date, market_cap_raw_text, market_cap_value, market_cap_unit, market_cap_as_of_date, range_cap_source, company_profile, company_profile_as_of_date, profile_source, updated_at)
           VALUES ($1,$2,$3,$4::date,$5,$6,$7,$4::date,'YAHOO_HK_FINANCE',$8,CASE WHEN $9 THEN $4::date ELSE NULL END,'TWSE_MOPS_T05ST03',now())
           ON CONFLICT (stock_id) DO UPDATE SET
             week52_low=EXCLUDED.week52_low, week52_high=EXCLUDED.week52_high, week52_as_of_date=EXCLUDED.week52_as_of_date,
             market_cap_raw_text=EXCLUDED.market_cap_raw_text, market_cap_value=EXCLUDED.market_cap_value, market_cap_unit=EXCLUDED.market_cap_unit, market_cap_as_of_date=EXCLUDED.market_cap_as_of_date,
             company_profile=CASE WHEN $9 THEN EXCLUDED.company_profile ELSE stock_yahoo_hk_profile.company_profile END,
             company_profile_as_of_date=CASE WHEN $9 THEN EXCLUDED.company_profile_as_of_date ELSE stock_yahoo_hk_profile.company_profile_as_of_date END,
             updated_at=now()`,
          stock.id, rangeCap.data.week52Low, rangeCap.data.week52High, todayDate,
          rangeCap.data.marketCapRawText, rangeCap.data.marketCapValue, rangeCap.data.marketCapUnit,
          profileText, profileFetched,
        );
        succeeded++;
      } else {
        failed++;
      }
      lastProcessedTicker = stock.ticker;
      await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
        lastSymbol: lastProcessedTicker,
        processed: (isFromToday ? effectiveCheckpoint?.processed ?? 0 : 0) + processed,
        succeeded: (isFromToday ? effectiveCheckpoint?.succeeded ?? 0 : 0) + succeeded,
        failed: (isFromToday ? effectiveCheckpoint?.failed ?? 0 : 0) + failed,
      });
      await sleep(REQUEST_DELAY_MS);
    } catch (e) {
      failed++;
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const reachedEnd = !blocked && index >= stocks.length;
  if (reachedEnd) {
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, { lastSymbol: null, processed, succeeded, failed, updatedAt: null });
  }

  await finishRun(runId, JOB, "YAHOO_HK_FINANCE+TWSE_MOPS", startedMs, {
    status: blocked ? "FAILED" : reachedEnd ? "COMPLETED" : "PARTIAL",
    attempted: processed, completed: succeeded, inserted: succeeded, updated: 0, failed,
    retryableFailures: 0,
    checkpointAfter: { lastSymbol: reachedEnd ? null : lastProcessedTicker, processed, succeeded, failed, updatedAt: null },
    error: blocked ? `blocked with HTTP ${blockedHttpStatus}` : null,
  });

  return Response.json({ ok: !blocked, job: JOB, processed, succeeded, failed, blocked, blockedHttpStatus, reachedEnd, universeCount: stocks.length, startIndex: Math.max(startIndex, 0) });
}
