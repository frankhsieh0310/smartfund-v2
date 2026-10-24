// 選股反查（技術面＋基本面，part 1 of 2 — stock screening）. Reverse-lookup to "which ETF/fund
// holds this stock" is NOT duplicated here: this endpoint returns matching tickers, and the
// client feeds them into the already-existing /api/mobile/reverse-holdings (same endpoint the
// plain stock reverse-lookup screen already uses) to get the ETF/fund list — one database of
// holdings logic, not two. This is the ONE entry point for 技術選股反查 — do not build a second
// screener route; extend this one (2026-10-24 使用者明確指示).
//
// 2026-10-24（資料來源原則，使用者核准定案，見CLAUDE.md）: 基本面九項（本益比/股價淨值比/殖利率
// /ROE/ROA/營收成長率/盈餘成長率/毛利率/淨利率）一律讀 lib/cron/yahooFundamentalsSync.ts 寫入的
// yahoo_fundamentals.* 事實（照抄Yahoo quoteSummary，不自己算）。PE額外COALESCE舊的
// valuation.pe/valuation.pe.ttm.point_in_time（官方BWIBBU/SEC來源）當交叉核對備援——Yahoo同步
// cron是每小時跑一批，全市場還沒覆蓋到的股票，PE暫時retrieve官方已經算好的值，不是自己重算；
// 其餘八項Yahoo還沒覆蓋到就是null（「無資料」），不補算、不fallback到別的來源硬湊。
// ROE/ROA/成長率/毛利率/淨利率這些原本因為net_income的TTM還原問題被排除（見上一版註解）——
// 現在全部改讀Yahoo現成算好的比率，不再有那個問題。
import { prisma } from "@/lib/prisma";
import { getAccountForRequest } from "@/lib/auth/userService";
import { SCREENER_FREE_MAX_CONDITIONS, SCREENER_FREE_MAX_RESULTS } from "@/lib/payments/plans";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

const FUNDAMENTAL_FIELDS = ["pe", "pb", "dividendYield", "roe", "roa", "revenueGrowth", "earningsGrowth", "grossMargin", "profitMargin"] as const;
type FundamentalField = (typeof FUNDAMENTAL_FIELDS)[number];
const PE_FALLBACK_METRICS = ["valuation.pe", "valuation.pe.ttm.point_in_time"];

type Condition =
  | { field: "rsi14"; op: "lt" | "gt"; value: number }
  | { field: "macd_histogram"; op: "lt" | "gt"; value: number }
  | { field: "price_vs_ma20"; op: "above" | "below" }
  | { field: "price_vs_ma60"; op: "above" | "below" }
  | { field: FundamentalField; op: "lt" | "gt"; value: number };

function isFundamentalField(field: string): field is FundamentalField {
  return (FUNDAMENTAL_FIELDS as readonly string[]).includes(field);
}

function parseConditions(q: URLSearchParams): Condition[] {
  const conditions: Condition[] = [];
  const rsiBelow = q.get("rsi_below");
  const rsiAbove = q.get("rsi_above");
  if (rsiBelow !== null && Number.isFinite(Number(rsiBelow))) conditions.push({ field: "rsi14", op: "lt", value: Number(rsiBelow) });
  if (rsiAbove !== null && Number.isFinite(Number(rsiAbove))) conditions.push({ field: "rsi14", op: "gt", value: Number(rsiAbove) });
  const macdBelow = q.get("macd_histogram_below");
  const macdAbove = q.get("macd_histogram_above");
  if (macdBelow !== null && Number.isFinite(Number(macdBelow))) conditions.push({ field: "macd_histogram", op: "lt", value: Number(macdBelow) });
  if (macdAbove !== null && Number.isFinite(Number(macdAbove))) conditions.push({ field: "macd_histogram", op: "gt", value: Number(macdAbove) });
  const priceVsMa20 = q.get("price_vs_ma20");
  if (priceVsMa20 === "above" || priceVsMa20 === "below") conditions.push({ field: "price_vs_ma20", op: priceVsMa20 });
  const priceVsMa60 = q.get("price_vs_ma60");
  if (priceVsMa60 === "above" || priceVsMa60 === "below") conditions.push({ field: "price_vs_ma60", op: priceVsMa60 });
  for (const field of FUNDAMENTAL_FIELDS) {
    const snake = field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    const below = q.get(`${snake}_below`);
    const above = q.get(`${snake}_above`);
    if (below !== null && Number.isFinite(Number(below))) conditions.push({ field, op: "lt", value: Number(below) });
    if (above !== null && Number.isFinite(Number(above))) conditions.push({ field, op: "gt", value: Number(above) });
  }
  return conditions;
}

function buildWhere(conditions: Condition[]): string {
  const clauses = conditions.map((c) => {
    if (c.field === "rsi14") return `t.rsi14 IS NOT NULL AND t.rsi14 ${c.op === "lt" ? "<" : ">"} ${c.value}`;
    if (c.field === "macd_histogram") return `t.macd_histogram IS NOT NULL AND t.macd_histogram ${c.op === "lt" ? "<" : ">"} ${c.value}`;
    if (c.field === "price_vs_ma20") return `t.ma20 IS NOT NULL AND s.latest_close IS NOT NULL AND s.latest_close ${c.op === "above" ? ">" : "<"} t.ma20`;
    if (c.field === "price_vs_ma60") return `t.ma60 IS NOT NULL AND s.latest_close IS NOT NULL AND s.latest_close ${c.op === "above" ? ">" : "<"} t.ma60`;
    return `f_${c.field}.value IS NOT NULL AND f_${c.field}.value ${c.op === "lt" ? "<" : ">"} ${c.value}`;
  });
  return clauses.length ? `AND ${clauses.join(" AND ")}` : "";
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  let conditions = parseConditions(q);
  if (conditions.length === 0) {
    return Response.json({
      ok: false, error: "NO_CONDITIONS",
      hint: "技術面: rsi_below|rsi_above|macd_histogram_below|macd_histogram_above=<number>, price_vs_ma20|price_vs_ma60=above|below. 基本面(Yahoo): pe|pb|dividend_yield|roe|roa|revenue_growth|earnings_growth|gross_margin|profit_margin + _below|_above=<number>",
    }, { status: 400, headers });
  }

  // 免費／付費分層（2026-10-24使用者核准定案）: 伺服器端強制執行，不能只靠前端藏起來——
  // 未登入或試用期已過的免費帳號，條件數最多3個、結果最多20檔；登入帳號用getAccountForRequest
  // 的accessTier（跟其他付費功能共用同一套FREE_FEATURES/PAID_FEATURES判斷邏輯），不用另外寫
  // 一套。totalMatchedBeforeLimit用來讓前端顯示「還有N檔符合條件」。
  const account = await getAccountForRequest(request).catch(() => null);
  const isPaidOrTrial = account?.accessTier === "trial" || account?.accessTier === "paid";
  const truncatedConditions = !isPaidOrTrial && conditions.length > SCREENER_FREE_MAX_CONDITIONS;
  if (truncatedConditions) conditions = conditions.slice(0, SCREENER_FREE_MAX_CONDITIONS);

  const limit = isPaidOrTrial
    ? Math.min(50, Math.max(1, Number(q.get("limit")) || 20))
    : SCREENER_FREE_MAX_RESULTS;
  const market = q.get("market"); // "TW" | "US" | null(=both)
  const marketClause = market === "TW" || market === "US" ? `AND s.country = '${market}'` : "";
  const where = buildWhere(conditions);
  const neededFields = new Set(conditions.filter((c): c is Extract<Condition, { field: FundamentalField }> => isFundamentalField(c.field)).map((c) => c.field));

  const fundamentalSelect = [...neededFields].map((f) => `f_${f}.value::text AS "${f}"`).join(", ");
  const fundamentalJoins = [...neededFields].map((f) => {
    if (f === "pe") {
      // PE 額外COALESCE舊官方來源備援（見檔頭說明），其餘八項純讀Yahoo，沒有就是null。
      return `LEFT JOIN LATERAL (
        SELECT COALESCE(
          (SELECT value FROM stock_financial_facts WHERE stock_id = s.id AND metric = 'yahoo_fundamentals.pe' ORDER BY period_end DESC LIMIT 1),
          (SELECT value FROM stock_financial_facts WHERE stock_id = s.id AND metric = ANY($pe_fallback::text[]) ORDER BY period_end DESC LIMIT 1)
        ) AS value
      ) f_pe ON true`;
    }
    return `LEFT JOIN LATERAL (
      SELECT value FROM stock_financial_facts WHERE stock_id = s.id AND metric = 'yahoo_fundamentals.${f}' ORDER BY period_end DESC LIMIT 1
    ) f_${f} ON true`;
  }).join("\n");

  const needsPeFallback = neededFields.has("pe");
  const fromClause = `FROM stocks s
       CROSS JOIN LATERAL (
         SELECT * FROM stock_technical st WHERE st.stock_id = s.id ORDER BY st.date DESC LIMIT 1
       ) t
       ${fundamentalJoins}
      WHERE s.is_active ${marketClause} ${where}`;
  // 免費版結果數受限時多拿一筆，用來判斷「還有更多」；真的有更多才額外付一次COUNT查詢的成本
  // 換精確數字（使用者規格要求顯示「還有N檔符合條件」，不是只顯示「還有更多」）。
  const fetchLimit = isPaidOrTrial ? limit : limit + 1;
  const sql = `SELECT s.ticker, s.company_name, s.country, t.date::text, t.rsi14::text, t.macd_histogram::text, t.ma20::text, t.ma60::text, s.latest_close::text AS "latestPrice"
            ${fundamentalSelect ? `, ${fundamentalSelect}` : ""}
       ${fromClause}
      ORDER BY t.date DESC
      LIMIT ${fetchLimit}`.replace("$pe_fallback", "$1");

  const queryParams = needsPeFallback ? [PE_FALLBACK_METRICS] : [];
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, string | null>>>(sql, ...queryParams);

  let remainingCount: number | null = null;
  if (!isPaidOrTrial && rows.length > limit) {
    const countSql = `SELECT count(*)::int n ${fromClause}`.replace("$pe_fallback", "$1");
    const countRows = await prisma.$queryRawUnsafe<{ n: number }[]>(countSql, ...queryParams);
    remainingCount = Math.max(0, (countRows[0]?.n ?? limit) - limit);
    rows.length = limit;
  }

  return Response.json({
    ok: true,
    conditions,
    market: market === "TW" || market === "US" ? market : "ALL",
    total: rows.length,
    generated_at: new Date().toISOString(),
    tier: isPaidOrTrial ? "FULL" : "FREE",
    truncatedConditions,
    remainingCount,
    upgradeHint: !isPaidOrTrial && (truncatedConditions || remainingCount)
      ? `免費版最多${SCREENER_FREE_MAX_CONDITIONS}個條件、顯示前${SCREENER_FREE_MAX_RESULTS}檔結果${remainingCount ? `，還有 ${remainingCount} 檔符合條件` : ""}。升級查看完整結果。`
      : null,
    results: rows.map((r) => ({
      ticker: r.ticker,
      name: r.company_name,
      country: r.country,
      asOfDate: r.date,
      rsi14: r.rsi14 !== null ? Number(r.rsi14) : null,
      macdHistogram: r.macd_histogram !== null ? Number(r.macd_histogram) : null,
      ma20: r.ma20 !== null ? Number(r.ma20) : null,
      ma60: r.ma60 !== null ? Number(r.ma60) : null,
      latestPrice: r.latestPrice !== null ? Number(r.latestPrice) : null,
      ...Object.fromEntries(FUNDAMENTAL_FIELDS.map((f) => [f, r[f] !== undefined && r[f] !== null ? Number(r[f]) : null])),
    })),
  }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
