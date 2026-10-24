// 選股反查（技術面＋基本面，part 1 of 2 — stock screening）. Reverse-lookup to "which ETF/fund
// holds this stock" is NOT duplicated here: this endpoint returns matching tickers, and the
// client feeds them into the already-existing /api/mobile/reverse-holdings (same endpoint the
// plain stock reverse-lookup screen already uses) to get the ETF/fund list — one database of
// holdings logic, not two. This is the ONE entry point for 技術選股反查 — do not build a second
// screener route; extend this one (2026-10-24 使用者明確指示).
//
// 2026-10-24（選股反查第一階段，盤點更正，使用者核准定案）: 上一輪的盤點誤判「stock_technical
// 全面落後3個月」——實際查證台股（2330）是接近即時的（stock-technical-daily這支cron台股本來就
// 正常在跑），真正的缺口是這支cron「只排了台股」，美股完全沒被排進任何每日更新（AAPL確認卡在
// 2026-08-14）。lib/cron/stockTechnicalDaily.ts 已經補上 findStaleUsStocks + 新的
// stock-technical-daily-us cron（shadow mode，等核准開啟寫入）。這支screener維持「現有資料就是
// 現有資料」的誠實原則：美股寫入正式開啟前，美股結果一樣能篩，只是日期可能還沒更新到最新。
//
// 基本面條件只接上「資料庫裡真實存在、不用自行估算」的欄位：
//   PE：stock_financial_facts 的 valuation.pe（台股 TWSE_OFFICIAL_BWIBBU 每日）或
//       valuation.pe.ttm.point_in_time（美股，偏好 SMARTFUND_PE_DAILY_RECOMPUTE_V1 其次
//       SEC_EDGAR_PLUS_YAHOO_PRICE）——這兩個欄位本身已經是cloud-global-pe-recompute／
//       cloud-tw-fundamentals-refresh用正確TTM邏輯算好的，這裡只是讀，不是自己重算。
//
// ROE 這次刻意不接（2026-10-24，實作中發現並排除，不是漏掉）: 原本想用
// financial.net_income÷financial.shareholders_equity，但美股(SEC)同一個period_end底下會有
// 「單季」跟「YTD累計」兩筆net_income並存（例如AAPL 2026-06-27：單季297.89億 vs
// YTD累計1014.64億，差3.4倍），台股(MOPS)net_income則整年都是YTD累計（fiscal_period統一是
// "Q1_YTD"/"Q2_YTD".../"FY"，沒有單季欄位）——兩邊都需要跟EPS一樣的TTM正確還原邏輯
// （lib/fundamentals/canonicalEps.ts的resolveTtmEps()已經解決這個問題，但是對EPS不是對
// net_income，要搬過來或另外做），貿然用「抓最新period_end」會算出錯誤或被低估3-4倍的ROE，
// 違反「基本面比率不准自行估算」——這裡選擇先不接，讓這個條件在篩選器回傳null，而不是接一個
// 可能錯的數字進去。下一階段要做ROE，先處理這個TTM還原問題。
// 殖利率／營收成長率／EPS成長率／PB 目前個股層級沒有可用的官方原始欄位（殖利率只有ETF/基金
// 有），這輪先不接，寧可少一個條件也不要生造數字；之後真的有資料來源再補。
import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

type Condition =
  | { field: "rsi14"; op: "lt" | "gt"; value: number }
  | { field: "macd_histogram"; op: "lt" | "gt"; value: number }
  | { field: "price_vs_ma20"; op: "above" | "below" }
  | { field: "price_vs_ma60"; op: "above" | "below" }
  | { field: "pe"; op: "lt" | "gt"; value: number };

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
  const peBelow = q.get("pe_below");
  const peAbove = q.get("pe_above");
  if (peBelow !== null && Number.isFinite(Number(peBelow))) conditions.push({ field: "pe", op: "lt", value: Number(peBelow) });
  if (peAbove !== null && Number.isFinite(Number(peAbove))) conditions.push({ field: "pe", op: "gt", value: Number(peAbove) });
  return conditions;
}

const PE_METRICS = ["valuation.pe", "valuation.pe.ttm.point_in_time"];

function buildWhere(conditions: Condition[]): string {
  const clauses = conditions.map((c) => {
    if (c.field === "rsi14") return `t.rsi14 IS NOT NULL AND t.rsi14 ${c.op === "lt" ? "<" : ">"} ${c.value}`;
    if (c.field === "macd_histogram") return `t.macd_histogram IS NOT NULL AND t.macd_histogram ${c.op === "lt" ? "<" : ">"} ${c.value}`;
    if (c.field === "price_vs_ma20") return `t.ma20 IS NOT NULL AND s.latest_close IS NOT NULL AND s.latest_close ${c.op === "above" ? ">" : "<"} t.ma20`;
    if (c.field === "price_vs_ma60") return `t.ma60 IS NOT NULL AND s.latest_close IS NOT NULL AND s.latest_close ${c.op === "above" ? ">" : "<"} t.ma60`;
    return `pe.value IS NOT NULL AND pe.value ${c.op === "lt" ? "<" : ">"} ${c.value}`;
  });
  return clauses.length ? `AND ${clauses.join(" AND ")}` : "";
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const conditions = parseConditions(q);
  if (conditions.length === 0) {
    return Response.json({
      ok: false, error: "NO_CONDITIONS",
      hint: "技術面: rsi_below|rsi_above|macd_histogram_below|macd_histogram_above=<number>, price_vs_ma20|price_vs_ma60=above|below. 基本面: pe_below|pe_above=<number>",
    }, { status: 400, headers });
  }
  const limit = Math.min(50, Math.max(1, Number(q.get("limit")) || 20));
  const market = q.get("market"); // "TW" | "US" | null(=both)
  const marketClause = market === "TW" || market === "US" ? `AND s.country = '${market}'` : "";
  const where = buildWhere(conditions);
  const needsPe = conditions.some((c) => c.field === "pe");

  // 跟既有技術面LATERAL join同一個bounded做法（每檔股票用索引取最新一筆，不是對整張事實表做
  // WHERE全表掃描，否則會像這輪盤點時遇到的一樣直接statement timeout）。PE這個LATERAL只在真的
  // 需要時才join，不需要時完全不碰stock_financial_facts，維持原本~3.8s的效能。
  const rows = await prisma.$queryRawUnsafe<
    { ticker: string; company_name: string; country: string; date: string; rsi14: string | null; macd_histogram: string | null; ma20: string | null; ma60: string | null; latestPrice: string | null; pe: string | null }[]
  >(
    `SELECT s.ticker, s.company_name, s.country, t.date::text, t.rsi14::text, t.macd_histogram::text, t.ma20::text, t.ma60::text, s.latest_close::text AS "latestPrice",
            ${needsPe ? "pe.value::text" : "NULL"} AS pe
       FROM stocks s
       CROSS JOIN LATERAL (
         SELECT * FROM stock_technical st WHERE st.stock_id = s.id ORDER BY st.date DESC LIMIT 1
       ) t
       ${needsPe ? `LEFT JOIN LATERAL (
         SELECT value FROM stock_financial_facts f WHERE f.stock_id = s.id AND f.metric = ANY($1::text[]) ORDER BY f.period_end DESC LIMIT 1
       ) pe ON true` : ""}
      WHERE s.is_active ${marketClause} ${where}
      ORDER BY t.date DESC
      LIMIT ${limit}`,
    ...(needsPe ? [PE_METRICS] : []),
  );

  return Response.json({
    ok: true,
    conditions,
    market: market === "TW" || market === "US" ? market : "ALL",
    total: rows.length,
    generated_at: new Date().toISOString(),
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
      pe: r.pe !== null ? Number(r.pe) : null,
    })),
  }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
