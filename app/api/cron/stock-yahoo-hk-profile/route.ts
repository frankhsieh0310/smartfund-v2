// 2026-11-08（使用者第36輪指令第三點核准）: 全部台股上市櫃個股的公司簡介（證交所MOPS「主要經營
// 業務」），每個月跑一次（用 company_profile_as_of_date 判斷超過25天才重抓，避免每天重複打同一個
// 官方頁面）。
// 2026-11-11（使用者核准，美股總覽頁補齊，後續更正公司簡介來源為CMoney）: 擴大到美股
// （NASDAQ/NYSE/NYQ/NMS/NCM/NGM，不含AMEX/OTC）——公司簡介美股沒有TWSE MOPS可用，改用CMoney
// 美股公司簡介頁的「中文公司簡介」欄位（見stockUsCompanyProfile.ts，VERIFIED NVDA/AAPL/TSLA/JPM
// 四檔都抓得到）。MoneyDJ備援（使用者原始要求）查過其「經營概述」頁面需要執行用戶端JavaScript才
// 會填入內容，跟這個repo既有的純HTTP GET原則衝突，沒有實作，查無的一律算「兩邊都沒有」回報，
// 不自行開無頭瀏覽器或換裝瀏覽器UA去繞過。
// 2026-11-11（美股先行）+2026-11-12（台股跟進，使用者核准定案）: 52週區間/市值不再抄雅虎財經
// 香港站——VERIFIED該站持續回傳HTTP 503/被擋，逐檔抓取的做法對美股跟台股都撐不住。改成完全
// 自行計算：52週區間直接讀我們自己資料庫的stock_history（lib/data-platform/web/stockService.ts
// serve時現算，這支排程完全不用管52週區間）；市值＝serve時的最新收盤價×流通在外股數——美股
// 流通在外股數來自CMoney（跟中文簡介同一次HTTP GET一起抓，每月一次，逐檔）；台股流通在外股數
// 改用證交所/櫃買中心官方開放資料t187ap03_L/t187ap03_O（見twOfficialSharesOutstanding.ts，
// 一次HTTP GET拿全市場，不是逐檔抓，完全沒有被節流/被擋的問題，一天整批刷新一次即可）。
// 美股公司簡介+流通在外股數每月一次CMoney逐檔抓取，大多數交易日直接跳過（profile還沒到期）；
// 台股公司簡介同樣每月一次MOPS逐檔抓取；台股流通在外股數則每天整批刷新（跟逐檔的公司簡介
// checkpoint分開記）。
// 抓取禮貌（僅剩的兩個逐檔外部請求：MOPS公司簡介、CMoney美股簡介）：每檔間隔至少2秒、遇到
// BLOCKED整個invocation立刻停止（不重試、不換頭換身分，隔天排程會從checkpoint自然接續，不會
// 整批失敗）、凌晨01:00-05:30台北時間不跑。時間箱＋checkpoint游標，單次invocation處理有限檔數，
// 跟etf-official-holdings同一種節奏。沒有新增排程，沿用既有的stock-yahoo-hk-profile這支。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint, type CheckpointRow } from "@/lib/cloud-ingestion/runContext";
import { fetchTwseCompanyProfile, inForbiddenWindowTaipei } from "@/lib/data-platform/web/stockYahooHkProfile";
import { fetchCMoneyUsCompanyProfile } from "@/lib/data-platform/web/stockUsCompanyProfile";
import { fetchOfficialTwSharesOutstanding } from "@/lib/data-platform/web/twOfficialSharesOutstanding";
import { refreshReverseLookupCacheBatch } from "@/lib/data-platform/reverseLookupCache";
import { refreshActiveEtfDailyChangesCache } from "@/lib/data-platform/activeEtfChangesCache";

const US_EXCHANGES = ["NASDAQ", "NYSE", "NYQ", "NMS", "NCM", "NGM"];

export const runtime = "nodejs";
export const maxDuration = 290;
export const dynamic = "force-dynamic";

const JOB = "STOCK_YAHOO_HK_PROFILE";
const CHECKPOINT_KEY = "stock-yahoo-hk-profile:daily-cursor";
const TW_SHARES_CHECKPOINT_KEY = "stock-yahoo-hk-profile:tw-shares-daily";
const REVERSE_CACHE_CHECKPOINT_KEY = "stock-yahoo-hk-profile:reverse-lookup-cache-cursor";
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

  // 2026-11-12（使用者核准定案）: 台股市值改用「最新收盤價 × 證交所/櫃買中心官方開放已發行股數」，
  // 一天一次整批刷新即可（官方資料本身也是一天更新一次），不用每10分鐘重打；跟每檔逐筆的公司
  // 簡介checkpoint分開記一個daily checkpoint，當天已經刷新過就跳過。
  const sharesCheckpoint = await readCheckpoint(TW_SHARES_CHECKPOINT_KEY);
  let twSharesResult: { status: string; updated?: number; httpStatus?: number; source?: string } = { status: "SKIPPED_ALREADY_FRESH" };
  if (taipeiDateKey(sharesCheckpoint?.updatedAt ?? null) !== todayTaipeiKey()) {
    const outcome = await fetchOfficialTwSharesOutstanding();
    if (outcome.status === "OK") {
      const twStocks = await prisma.stock.findMany({
        where: { isActive: true, exchange: { in: ["TWSE", "TPEx", "TPEX"] } },
        select: { id: true, ticker: true },
      });
      const ids: string[] = [], shares: number[] = [];
      for (const s of twStocks) {
        const n = outcome.byTicker.get(s.ticker);
        if (n != null) { ids.push(s.id); shares.push(n); }
      }
      if (ids.length) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO stock_yahoo_hk_profile (stock_id, shares_outstanding, shares_outstanding_as_of_date, updated_at)
             SELECT t.stock_id, t.shares, $3::date, now() FROM UNNEST($1::uuid[], $2::numeric[]) AS t(stock_id, shares)
           ON CONFLICT (stock_id) DO UPDATE SET
             shares_outstanding = EXCLUDED.shares_outstanding, shares_outstanding_as_of_date = EXCLUDED.shares_outstanding_as_of_date, updated_at = now()`,
          ids, shares, outcome.asOfDate,
        );
      }
      await writeCheckpoint(JOB, TW_SHARES_CHECKPOINT_KEY, runId, { lastSymbol: "DONE", processed: ids.length, succeeded: ids.length, failed: 0 });
      twSharesResult = { status: "OK", updated: ids.length };
    } else {
      // 官方開放資料被擋/解析失敗——誠實回報，不影響下面逐檔公司簡介流程（兩者獨立），明天
      // checkpoint還是今天的舊值，下次invocation會再試一次。
      twSharesResult = outcome.status === "BLOCKED" ? { status: "BLOCKED", httpStatus: outcome.httpStatus, source: outcome.source } : { status: "PARSE_FAILED" };
    }
  }

  // 2026-11-12（使用者核准定案，反查效能）: 反查單一股票的快取表（見reverseLookupCache.ts）
  // best-effort批次刷新——跟技術選股的screener_preset_cache同一種附加步驟模式，只讀
  // reverse_current_positions/reverse_current_securities（完全不寫這兩張表或reverse_refresh_
  // queue，不碰那套曾經出過事故的子系統本身），只寫自己的reverse_single_ticker_cache。
  // 用checkpoint游標跨多次invocation接續，7671檔（目前規模）跑完一輪後下次invocation繼續從頭
  // 刷新。任何一步失敗只記錄、絕不影響這支排程本來的主要工作（公司簡介/流通在外股數）。
  const reverseCacheCheckpoint = await readCheckpoint(REVERSE_CACHE_CHECKPOINT_KEY);
  let reverseCacheResult: { status: string; processed?: number; updated?: number; anomalyCount?: number; failedCount?: number } = { status: "SKIPPED" };
  try {
    const cursor = reverseCacheCheckpoint?.lastSymbol === "DONE" ? null : (reverseCacheCheckpoint?.lastSymbol ?? null);
    const batch = await refreshReverseLookupCacheBatch(cursor, 500, 30_000);
    await writeCheckpoint(JOB, REVERSE_CACHE_CHECKPOINT_KEY, runId, { lastSymbol: batch.done ? "DONE" : batch.lastTicker, processed: batch.processed, succeeded: batch.updated, failed: batch.failed.length });
    reverseCacheResult = { status: "OK", processed: batch.processed, updated: batch.updated, anomalyCount: batch.anomalySkipped.length, failedCount: batch.failed.length };
    if (batch.anomalySkipped.length) {
      console.error(`[reverse-lookup-cache] anomaly: ${batch.anomalySkipped.length} ticker(s) had newCount < oldCount*0.5, kept old cache: ${JSON.stringify(batch.anomalySkipped)}`);
    }
  } catch (e) {
    reverseCacheResult = { status: "ERROR" };
    console.error("[reverse-lookup-cache] refresh batch failed", e instanceof Error ? e.message : e);
  }

  // 2026-11-13（使用者回報核實，主動式ETF追蹤頁第一次載入約15秒）: 跟上面reverse-lookup-cache
  // 同一種best-effort附加步驟——整批（~20幾檔「主動」ETF，量很小）重算一次寫進唯一一筆快取列，
  // 不用checkpoint游標（下一次invocation直接整批重算覆蓋，不是接續）。任何錯誤只記錄，不影響
  // 這支排程本來的主要工作。
  let activeEtfCacheResult: { status: string; count?: number; error?: string } = { status: "SKIPPED" };
  try {
    const result = await refreshActiveEtfDailyChangesCache();
    activeEtfCacheResult = result.ok ? { status: "OK", count: result.count } : { status: "ERROR", error: result.error };
  } catch (e) {
    activeEtfCacheResult = { status: "ERROR", error: e instanceof Error ? e.message : String(e) };
    console.error("[active-etf-daily-changes-cache] refresh failed", e instanceof Error ? e.message : e);
  }

  let processed = 0, succeeded = 0, failed = 0, noProfileEitherSource = 0, blocked = false, blockedHttpStatus: number | null = null;
  let lastProcessedTicker: string | null = effectiveCheckpoint?.lastSymbol ?? null;
  let index = Math.max(startIndex, 0);
  const todayDate = todayTaipeiKey();

  for (; index < stocks.length; index++) {
    const elapsed = Date.now() - startedMs;
    if (HARD_DEADLINE_MS - elapsed < MIN_REMAINING_TO_START_MS) break;
    const stock = stocks[index];
    processed++;
    const isUsExchange = US_EXCHANGES.includes(stock.exchange ?? "");
    try {
      const existing = await prisma.$queryRawUnsafe<Array<{ company_profile_as_of_date: Date | null }>>(
        `SELECT company_profile_as_of_date FROM stock_yahoo_hk_profile WHERE stock_id = $1`, stock.id,
      );
      const profileAge = existing[0]?.company_profile_as_of_date
        ? (Date.now() - new Date(existing[0].company_profile_as_of_date).getTime()) / 86_400_000
        : Infinity;

      if (isUsExchange) {
        // 美股：52週區間/市值不再抓取，serve時自算；這裡只做公司簡介+流通在外股數的每月CMoney
        // 更新，profile還沒到期就完全跳過這檔（不發任何HTTP請求）。
        if (profileAge > PROFILE_REFRESH_DAYS) {
          await sleep(REQUEST_DELAY_MS);
          const profile = await fetchCMoneyUsCompanyProfile(stock.ticker);
          if (profile.status === "BLOCKED") { blocked = true; blockedHttpStatus = profile.httpStatus; break; }
          const profileText = profile.status === "OK" ? profile.data : null;
          const sharesOutstanding = profile.status === "OK" || profile.status === "NOT_FOUND" ? profile.sharesOutstanding : null;
          const nameZh = profile.status === "OK" || profile.status === "NOT_FOUND" ? profile.nameZh : null;
          if (profile.status !== "OK") noProfileEitherSource++;
          await prisma.$executeRawUnsafe(
            `INSERT INTO stock_yahoo_hk_profile (stock_id, company_profile, company_profile_as_of_date, shares_outstanding, shares_outstanding_as_of_date, profile_source, updated_at)
             VALUES ($1,$2,$3::date,$4,$3::date,'CMONEY_US0026',now())
             ON CONFLICT (stock_id) DO UPDATE SET
               company_profile=EXCLUDED.company_profile, company_profile_as_of_date=EXCLUDED.company_profile_as_of_date,
               shares_outstanding=EXCLUDED.shares_outstanding, shares_outstanding_as_of_date=EXCLUDED.shares_outstanding_as_of_date,
               profile_source=EXCLUDED.profile_source, updated_at=now()`,
            stock.id, profileText, todayDate, sharesOutstanding,
          );
          // 2026-11-12 使用者核准定案（中文名稱缺漏）: CMoney頁面<h1>有中文名就一併補進
          // stocks.company_name_zh（跟台股既有欄位共用，不新增欄位）——只在真的抓到中文字時才寫，
          // 不會把英文原名當中文名存進去；只補目前還是NULL的（絕不覆寫既有值，萬一這裡抓到的
          // 跟既有其他來源不一致，不自己判斷誰對，保留既有值）。
          if (nameZh) {
            await prisma.$executeRawUnsafe(`UPDATE stocks SET company_name_zh = $1 WHERE id = $2 AND company_name_zh IS NULL`, nameZh, stock.id);
          }
          succeeded++;
        }
        // profile未到期：這檔這次完全不用做事，不算成功也不算失敗，直接進下一檔。
        lastProcessedTicker = stock.ticker;
        await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
          lastSymbol: lastProcessedTicker,
          processed: (isFromToday ? effectiveCheckpoint?.processed ?? 0 : 0) + processed,
          succeeded: (isFromToday ? effectiveCheckpoint?.succeeded ?? 0 : 0) + succeeded,
          failed: (isFromToday ? effectiveCheckpoint?.failed ?? 0 : 0) + failed,
        });
        continue;
      }

      // 台股：52週區間/市值serve時自算（跟美股同一套），不再呼叫雅虎財經香港站；這裡只剩
      // MOPS公司簡介，每月才真正發一次請求，profile還沒到期就跳過，不是每個交易日都跑。
      if (profileAge > PROFILE_REFRESH_DAYS) {
        await sleep(REQUEST_DELAY_MS);
        const profile = await fetchTwseCompanyProfile(stock.ticker);
        if (profile.status === "BLOCKED") { blocked = true; blockedHttpStatus = profile.httpStatus; break; }
        const profileText = profile.status === "OK" ? profile.data : null;
        if (profile.status !== "OK") noProfileEitherSource++; // 確認檢查過、MOPS沒有——仍更新as_of_date，避免每天重打
        await prisma.$executeRawUnsafe(
          `INSERT INTO stock_yahoo_hk_profile (stock_id, company_profile, company_profile_as_of_date, profile_source, updated_at)
           VALUES ($1,$2,$3::date,'TWSE_MOPS_T05ST03',now())
           ON CONFLICT (stock_id) DO UPDATE SET
             company_profile=EXCLUDED.company_profile, company_profile_as_of_date=EXCLUDED.company_profile_as_of_date,
             profile_source=EXCLUDED.profile_source, updated_at=now()`,
          stock.id, profileText, todayDate,
        );
        succeeded++;
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

  await finishRun(runId, JOB, "TWSE_TPEX_OFFICIAL+TWSE_MOPS+CMONEY_US0026", startedMs, {
    status: blocked ? "FAILED" : reachedEnd ? "COMPLETED" : "PARTIAL",
    attempted: processed, completed: succeeded, inserted: succeeded, updated: 0, failed,
    retryableFailures: 0,
    checkpointAfter: { lastSymbol: reachedEnd ? null : lastProcessedTicker, processed, succeeded, failed, updatedAt: null },
    error: blocked ? `blocked with HTTP ${blockedHttpStatus}` : null,
    details: { noProfileEitherSource, twSharesResult, reverseCacheResult, activeEtfCacheResult },
  });

  return Response.json({ ok: !blocked, job: JOB, processed, succeeded, failed, noProfileEitherSource, blocked, blockedHttpStatus, reachedEnd, universeCount: stocks.length, startIndex: Math.max(startIndex, 0), twSharesResult, reverseCacheResult, activeEtfCacheResult });
}
