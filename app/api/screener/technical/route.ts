// 選股反查（技術面＋基本面，part 1 of 2 — stock screening）. Reverse-lookup to "which ETF/fund
// holds this stock" is NOT duplicated here: this endpoint returns matching tickers, and the
// client feeds them into the already-existing /api/mobile/reverse-holdings (same endpoint the
// plain stock reverse-lookup screen already uses) to get the ETF/fund list — one database of
// holdings logic, not two. This is the ONE entry point for 技術選股反查 — do not build a second
// screener route; extend this one (2026-10-24 使用者明確指示).
//
// 核心查詢邏輯在 lib/screener/stockScreener.ts（2026-10-24抽出來，儲存條件提醒cron要重新跑
// 同一套邏輯，不是另外重寫SQL）。這支route只負責解析query、分層（免費/付費）、組回應格式。
import { getAccountForRequest } from "@/lib/auth/userService";
import { SCREENER_FREE_MAX_CONDITIONS, SCREENER_FREE_MAX_RESULTS, TRIAL_DAYS } from "@/lib/payments/plans";
import { parseScreenerConditions, runStockScreenerQuery, countStockScreenerMatches } from "@/lib/screener/stockScreener";
import { matchPresetKey, getCachedPresetResult } from "@/lib/screener/presetCache";

// 2026-11-09（模擬器實測第1項，使用者核准定案）: getAccountForRequest 對未登入的請求永遠回 null，
// 這支route原本因此永遠把未登入裝置當free——跟手機端14天新用戶免費期（不論有沒有登入都算，見
// smartmatch-mobile的 subscriptionConfig.ts isWithinNewUserGrace）不一致。手機端把本機記錄的
// 裝置第一次開啟日一起帶來，這裡用同一個TRIAL_DAYS規則單獨驗證——跟信任account.createdAt（使用者
// 一樣能靠重新註冊帳號規避）風險等級相同，不是另外開一個漏洞。
function isWithinDeviceGrace(deviceFirstOpenAtParam: string | null): boolean {
  if (!deviceFirstOpenAtParam) return false;
  const firstOpenAt = new Date(deviceFirstOpenAtParam).getTime();
  if (!Number.isFinite(firstOpenAt) || firstOpenAt > Date.now()) return false;
  return Date.now() - firstOpenAt < TRIAL_DAYS * 24 * 60 * 60 * 1000;
}

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  let conditions = parseScreenerConditions(q);
  if (conditions.length === 0) {
    return Response.json({
      ok: false, error: "NO_CONDITIONS",
      hint: "技術面: rsi_below|rsi_above|macd_histogram_below|macd_histogram_above=<number>, price_vs_ma20|price_vs_ma60=above|below. 基本面(Yahoo): pe|pb|dividend_yield|roe|roa|revenue_growth|earnings_growth|gross_margin|profit_margin + _below|_above=<number>",
    }, { status: 400, headers });
  }

  // 免費／付費分層（2026-10-24使用者核准定案）: 伺服器端強制執行，不能只靠前端藏起來——
  // 未登入或試用期已過的免費帳號，條件數最多3個、結果最多20檔；登入帳號用getAccountForRequest
  // 的accessTier（跟其他付費功能共用同一套FREE_FEATURES/PAID_FEATURES判斷邏輯），不用另外寫
  // 一套。remainingCount用來讓前端顯示「還有N檔符合條件」。
  const account = await getAccountForRequest(request).catch(() => null);
  const isPaidOrTrial =
    account?.accessTier === "trial" ||
    account?.accessTier === "paid" ||
    isWithinDeviceGrace(q.get("deviceFirstOpenAt"));
  const truncatedConditions = !isPaidOrTrial && conditions.length > SCREENER_FREE_MAX_CONDITIONS;
  if (truncatedConditions) conditions = conditions.slice(0, SCREENER_FREE_MAX_CONDITIONS);

  const limit = isPaidOrTrial
    ? Math.min(50, Math.max(1, Number(q.get("limit")) || 20))
    : SCREENER_FREE_MAX_RESULTS;
  const marketParam = q.get("market");
  const market = marketParam === "TW" || marketParam === "US" ? marketParam : null;

  // 2026-11-10（模擬器實測第3項，使用者核准定案）: 畫面只有5組固定範本按鈕，實際流量幾乎全部
  // 落在「範本 × TW/US」這10種組合——命中快取就直接讀 stock-technical-daily/-us 排程算好存起來
  // 的結果，不用每次都即時掃全市場技術指標＋基本面；沒命中（自訂條件組合，理論上UI不會送出，
  // 但保留防呆）或快取已經過舊，照舊即時查詢，行為跟修改前完全一致。
  const presetKey = market ? matchPresetKey(conditions) : null;
  const cached = presetKey && market ? await getCachedPresetResult(presetKey, market) : null;
  let rows: Awaited<ReturnType<typeof runStockScreenerQuery>>;
  let cachedTotal: number | null = null;
  let usedCache = false;
  if (cached) {
    rows = cached.rows.slice(0, limit + (isPaidOrTrial ? 0 : 1));
    cachedTotal = cached.total;
    usedCache = true;
  } else {
    rows = await runStockScreenerQuery(conditions, market, limit + (isPaidOrTrial ? 0 : 1));
  }
  let remainingCount: number | null = null;
  let results = rows;
  if (!isPaidOrTrial && rows.length > limit) {
    const total = cachedTotal ?? await countStockScreenerMatches(conditions, market);
    remainingCount = Math.max(0, total - limit);
    results = rows.slice(0, limit);
  }

  return Response.json({
    ok: true,
    conditions,
    market: market ?? "ALL",
    total: results.length,
    cached: usedCache,
    cachedAsOfDate: cached?.computedAt ?? null,
    generated_at: new Date().toISOString(),
    tier: isPaidOrTrial ? "FULL" : "FREE",
    truncatedConditions,
    remainingCount,
    upgradeHint: !isPaidOrTrial && (truncatedConditions || remainingCount)
      ? `免費版最多${SCREENER_FREE_MAX_CONDITIONS}個條件、顯示前${SCREENER_FREE_MAX_RESULTS}檔結果${remainingCount ? `，還有 ${remainingCount} 檔符合條件` : ""}。升級查看完整結果。`
      : null,
    results,
  }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
