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
import { SCREENER_FREE_MAX_CONDITIONS, SCREENER_FREE_MAX_RESULTS } from "@/lib/payments/plans";
import { parseScreenerConditions, runStockScreenerQuery, countStockScreenerMatches } from "@/lib/screener/stockScreener";

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
  const isPaidOrTrial = account?.accessTier === "trial" || account?.accessTier === "paid";
  const truncatedConditions = !isPaidOrTrial && conditions.length > SCREENER_FREE_MAX_CONDITIONS;
  if (truncatedConditions) conditions = conditions.slice(0, SCREENER_FREE_MAX_CONDITIONS);

  const limit = isPaidOrTrial
    ? Math.min(50, Math.max(1, Number(q.get("limit")) || 20))
    : SCREENER_FREE_MAX_RESULTS;
  const marketParam = q.get("market");
  const market = marketParam === "TW" || marketParam === "US" ? marketParam : null;

  const rows = await runStockScreenerQuery(conditions, market, limit + (isPaidOrTrial ? 0 : 1));
  let remainingCount: number | null = null;
  let results = rows;
  if (!isPaidOrTrial && rows.length > limit) {
    const total = await countStockScreenerMatches(conditions, market);
    remainingCount = Math.max(0, total - limit);
    results = rows.slice(0, limit);
  }

  return Response.json({
    ok: true,
    conditions,
    market: market ?? "ALL",
    total: results.length,
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
