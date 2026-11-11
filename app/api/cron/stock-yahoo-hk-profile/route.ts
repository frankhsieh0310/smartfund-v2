// 2026-11-08（使用者第36輪指令第三點核准）: 全部台股上市櫃個股的52週區間／市值（雅虎財經香港站）
// 跟公司簡介（證交所MOPS「主要經營業務」）。52週/市值每個交易日跑一次；公司簡介每個月跑一次
// （用 company_profile_as_of_date 判斷超過25天才重抓，避免每天重複打同一個官方頁面）。
// 2026-11-11（使用者核准，美股總覽頁補齊，後續更正公司簡介來源為CMoney）: 擴大到美股
// （NASDAQ/NYSE/NYQ/NMS/NCM/NGM，不含AMEX/OTC）——52週/市值同一支雅虎財經香港站函式本來就
// 跟股票市場無關，直接沿用；公司簡介美股沒有TWSE MOPS可用，改用CMoney美股公司簡介頁的「中文
// 公司簡介」欄位（見stockUsCompanyProfile.ts，VERIFIED NVDA/AAPL/TSLA/JPM四檔都抓得到）。
// MoneyDJ備援（使用者原始要求）查過其「經營概述」頁面需要執行用戶端JavaScript才會填入內容，
// 跟這個repo既有的純HTTP GET原則衝突，沒有實作，查無的一律算「兩邊都沒有」回報，不自行開無頭
// 瀏覽器或換裝瀏覽器UA去繞過。
// 抓取禮貌：每檔間隔至少2秒（比原本1秒慢，降低被節流機率——VERIFIED擴大到美股時雅虎財經香港站
// 連續打幾十檔後開始回傳HTTP 503，已經補上5xx一律視同BLOCKED立刻停止，不是只有401/403/429）、
// 遇到BLOCKED整個invocation立刻停止（不重試、不換頭換身分，隔天排程會從checkpoint自然接續，
// 不會整批失敗）、凌晨01:00-05:30台北時間不跑。時間箱＋checkpoint游標，單次invocation處理有限
// 檔數，跟etf-official-holdings同一種節奏。沒有新增排程，沿用既有的stock-yahoo-hk-profile這支。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint, type CheckpointRow } from "@/lib/cloud-ingestion/runContext";
import { fetchYahooHkRangeCap, fetchTwseCompanyProfile, inForbiddenWindowTaipei } from "@/lib/data-platform/web/stockYahooHkProfile";
import { fetchCMoneyUsCompanyProfile } from "@/lib/data-platform/web/stockUsCompanyProfile";

const US_EXCHANGES = ["NASDAQ", "NYSE", "NYQ", "NMS", "NCM", "NGM"];

export const runtime = "nodejs";
export const maxDuration = 290;
export const dynamic = "force-dynamic";

const JOB = "STOCK_YAHOO_HK_PROFILE";
const CHECKPOINT_KEY = "stock-yahoo-hk-profile:daily-cursor";
const HARD_DEADLINE_MS = 260_000;
const MIN_REMAINING_TO_START_MS = 5_000;
const REQUEST_DELAY_MS = 2_000; // 每檔至少間隔2秒（2026-11-11放慢，降低被節流機率）
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
    where: { isActive: true, exchange: { in: ["TWSE", "TPEx", "TPEX", ...US_EXCHANGES] } },
    orderBy: { ticker: "asc" },
    select: { id: true, ticker: true, yahooSymbol: true, exchange: true },
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

  let processed = 0, succeeded = 0, failed = 0, noProfileEitherSource = 0, blocked = false, blockedHttpStatus: number | null = null;
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
      const isUsExchange = US_EXCHANGES.includes(stock.exchange ?? "");
      if (profileAge > PROFILE_REFRESH_DAYS) {
        await sleep(REQUEST_DELAY_MS);
        const profile = isUsExchange
          ? await fetchCMoneyUsCompanyProfile(stock.ticker)
          : await fetchTwseCompanyProfile(stock.ticker);
        if (profile.status === "BLOCKED") { blocked = true; blockedHttpStatus = profile.httpStatus; break; }
        if (profile.status === "OK") { profileText = profile.data; profileFetched = true; }
        else { noProfileEitherSource++; profileFetched = true; } // 確認檢查過、CMoney（美股）或MOPS（台股）都沒有——仍更新as_of_date，避免每天重打
      }

      if (rangeCap.status === "OK") {
        const profileSource = isUsExchange ? "CMONEY_US0026" : "TWSE_MOPS_T05ST03";
        await prisma.$executeRawUnsafe(
          `INSERT INTO stock_yahoo_hk_profile (stock_id, week52_low, week52_high, week52_as_of_date, market_cap_raw_text, market_cap_value, market_cap_unit, market_cap_as_of_date, range_cap_source, company_profile, company_profile_as_of_date, profile_source, updated_at)
           VALUES ($1,$2,$3,$4::date,$5,$6,$7,$4::date,'YAHOO_HK_FINANCE',$8,CASE WHEN $9 THEN $4::date ELSE NULL END,$10,now())
           ON CONFLICT (stock_id) DO UPDATE SET
             week52_low=EXCLUDED.week52_low, week52_high=EXCLUDED.week52_high, week52_as_of_date=EXCLUDED.week52_as_of_date,
             market_cap_raw_text=EXCLUDED.market_cap_raw_text, market_cap_value=EXCLUDED.market_cap_value, market_cap_unit=EXCLUDED.market_cap_unit, market_cap_as_of_date=EXCLUDED.market_cap_as_of_date,
             company_profile=CASE WHEN $9 THEN EXCLUDED.company_profile ELSE stock_yahoo_hk_profile.company_profile END,
             company_profile_as_of_date=CASE WHEN $9 THEN EXCLUDED.company_profile_as_of_date ELSE stock_yahoo_hk_profile.company_profile_as_of_date END,
             profile_source=CASE WHEN $9 THEN EXCLUDED.profile_source ELSE stock_yahoo_hk_profile.profile_source END,
             updated_at=now()`,
          stock.id, rangeCap.data.week52Low, rangeCap.data.week52High, todayDate,
          rangeCap.data.marketCapRawText, rangeCap.data.marketCapValue, rangeCap.data.marketCapUnit,
          profileText, profileFetched, profileSource,
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
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, { lastSymbol: null, processed, succeeded, failed });
  }

  await finishRun(runId, JOB, "YAHOO_HK_FINANCE+TWSE_MOPS", startedMs, {
    status: blocked ? "FAILED" : reachedEnd ? "COMPLETED" : "PARTIAL",
    attempted: processed, completed: succeeded, inserted: succeeded, updated: 0, failed,
    retryableFailures: 0,
    checkpointAfter: { lastSymbol: reachedEnd ? null : lastProcessedTicker, processed, succeeded, failed, updatedAt: null },
    error: blocked ? `blocked with HTTP ${blockedHttpStatus}` : null,
    details: { noProfileEitherSource },
  });

  return Response.json({ ok: !blocked, job: JOB, processed, succeeded, failed, noProfileEitherSource, blocked, blockedHttpStatus, reachedEnd, universeCount: stocks.length, startIndex: Math.max(startIndex, 0) });
}
