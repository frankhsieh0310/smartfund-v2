// 選股反查核心查詢邏輯，從 app/api/screener/technical/route.ts 抽出來（2026-10-24，使用者核准
// 定案）——「儲存條件並在符合時提醒」這支新cron需要重新跑同一套篩選條件，不是另外重寫一份
// SQL（兩邊會drift）。route.ts本身改成呼叫這裡，只保留auth/分層那層。
import { prisma } from "@/lib/prisma";

export const FUNDAMENTAL_FIELDS = ["pe", "pb", "dividendYield", "roe", "roa", "revenueGrowth", "earningsGrowth", "grossMargin", "profitMargin"] as const;
export type FundamentalField = (typeof FUNDAMENTAL_FIELDS)[number];
const PE_FALLBACK_METRICS = ["valuation.pe", "valuation.pe.ttm.point_in_time"];

export type ScreenerCondition =
  | { field: "rsi14"; op: "lt" | "gt"; value: number }
  | { field: "macd_histogram"; op: "lt" | "gt"; value: number }
  | { field: "price_vs_ma20"; op: "above" | "below" }
  | { field: "price_vs_ma60"; op: "above" | "below" }
  | { field: FundamentalField; op: "lt" | "gt"; value: number };

export function isFundamentalField(field: string): field is FundamentalField {
  return (FUNDAMENTAL_FIELDS as readonly string[]).includes(field);
}

export function parseScreenerConditions(q: URLSearchParams): ScreenerCondition[] {
  const conditions: ScreenerCondition[] = [];
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

function buildWhere(conditions: ScreenerCondition[]): string {
  const clauses = conditions.map((c) => {
    if (c.field === "rsi14") return `t.rsi14 IS NOT NULL AND t.rsi14 ${c.op === "lt" ? "<" : ">"} ${c.value}`;
    if (c.field === "macd_histogram") return `t.macd_histogram IS NOT NULL AND t.macd_histogram ${c.op === "lt" ? "<" : ">"} ${c.value}`;
    if (c.field === "price_vs_ma20") return `t.ma20 IS NOT NULL AND s.latest_close IS NOT NULL AND s.latest_close ${c.op === "above" ? ">" : "<"} t.ma20`;
    if (c.field === "price_vs_ma60") return `t.ma60 IS NOT NULL AND s.latest_close IS NOT NULL AND s.latest_close ${c.op === "above" ? ">" : "<"} t.ma60`;
    return `f_${c.field}.value IS NOT NULL AND f_${c.field}.value ${c.op === "lt" ? "<" : ">"} ${c.value}`;
  });
  return clauses.length ? `AND ${clauses.join(" AND ")}` : "";
}

// 2026-10-24（獨立代理驗收發現，使用者核准修正）: PE的官方來源備援只能在「Yahoo完全沒查過這檔
// 股票」時使用——一旦Yahoo查過（不管Yahoo有沒有實際給出PE值），就要照Yahoo的結果為準，包含
// Yahoo判定「沒有PE」的情況（例如虧損股，Yahoo自己的頁面也不顯示PE）。原本的COALESCE邏輯分不出
// 「Yahoo還沒查」跟「Yahoo查過、真的沒有」兩種情況——兩者都是「沒有yahoo_fundamentals.pe這筆
// 資料」，會被誤接去讀舊的官方備援，等於虧損股被塞進一個Yahoo本來就不會顯示的PE數字，違反
// 「Yahoo沒有的數字顯示無資料，不准補算」。用yahoo_fundamentals._synced這個同步完成標記
// （lib/cron/yahooFundamentalsSync.ts每次成功打完Yahoo都會寫，不管九個欄位有沒有值）分辨兩者。
function buildFundamentalJoins(neededFields: Set<FundamentalField>): string {
  return [...neededFields].map((f) => {
    if (f === "pe") {
      return `LEFT JOIN LATERAL (
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM stock_financial_facts WHERE stock_id = s.id AND metric = 'yahoo_fundamentals._synced')
            THEN (SELECT value FROM stock_financial_facts WHERE stock_id = s.id AND metric = 'yahoo_fundamentals.pe' ORDER BY period_end DESC LIMIT 1)
          ELSE (SELECT value FROM stock_financial_facts WHERE stock_id = s.id AND metric = ANY($pe_fallback::text[]) ORDER BY period_end DESC LIMIT 1)
        END AS value
      ) f_pe ON true`;
    }
    return `LEFT JOIN LATERAL (
      SELECT value FROM stock_financial_facts WHERE stock_id = s.id AND metric = 'yahoo_fundamentals.${f}' ORDER BY period_end DESC LIMIT 1
    ) f_${f} ON true`;
  }).join("\n");
}

export type ScreenerRow = {
  ticker: string; yahooSymbol: string; name: string; country: string; technicalAsOfDate: string;
  rsi14: number | null; macdHistogram: number | null; ma20: number | null; ma60: number | null; latestPrice: number | null;
} & Record<FundamentalField, number | null>;

export async function runStockScreenerQuery(conditions: ScreenerCondition[], market: "TW" | "US" | null, limit: number): Promise<ScreenerRow[]> {
  const marketClause = market === "TW" || market === "US" ? `AND s.country = '${market}'` : "";
  const where = buildWhere(conditions);
  const neededFields = new Set(conditions.filter((c): c is Extract<ScreenerCondition, { field: FundamentalField }> => isFundamentalField(c.field)).map((c) => c.field));

  const fundamentalSelect = [...neededFields].map((f) => `f_${f}.value::text AS "${f}"`).join(", ");
  const fundamentalJoins = buildFundamentalJoins(neededFields);

  const needsPeFallback = neededFields.has("pe");
  const fromClause = `FROM stocks s
       CROSS JOIN LATERAL (
         SELECT * FROM stock_technical st WHERE st.stock_id = s.id ORDER BY st.date DESC LIMIT 1
       ) t
       ${fundamentalJoins}
      WHERE s.is_active ${marketClause} ${where}`;
  const sql = `SELECT s.ticker, s.yahoo_symbol AS "yahooSymbol", s.company_name, s.country, t.date::text, t.rsi14::text, t.macd_histogram::text, t.ma20::text, t.ma60::text, s.latest_close::text AS "latestPrice"
            ${fundamentalSelect ? `, ${fundamentalSelect}` : ""}
       ${fromClause}
      ORDER BY t.date DESC
      LIMIT ${limit}`.replace("$pe_fallback", "$1");

  const queryParams = needsPeFallback ? [PE_FALLBACK_METRICS] : [];
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, string | null>>>(sql, ...queryParams);
  return rows.map((r) => ({
    ticker: r.ticker!, yahooSymbol: r.yahooSymbol!, name: r.company_name!, country: r.country!, technicalAsOfDate: r.date!,
    // 2026-10-24（獨立代理驗收發現，使用者核准修正）: 原本叫asOfDate容易誤導——latestPrice跟PE
    // 其實分別來自不同、更新頻率不同的來源（latestPrice是stocks表自己的latest_close，由另一條
    // 更頻繁的價格cron更新；PE來自yahoo_fundamentals或官方備援），不是跟著這個技術指標日期走。
    // 改名明確只代表「這一列技術指標（RSI/MACD/MA）算到哪一天」。
    rsi14: r.rsi14 !== null ? Number(r.rsi14) : null,
    macdHistogram: r.macd_histogram !== null ? Number(r.macd_histogram) : null,
    ma20: r.ma20 !== null ? Number(r.ma20) : null,
    ma60: r.ma60 !== null ? Number(r.ma60) : null,
    latestPrice: r.latestPrice !== null ? Number(r.latestPrice) : null,
    ...Object.fromEntries(FUNDAMENTAL_FIELDS.map((f) => [f, r[f] !== undefined && r[f] !== null ? Number(r[f]) : null])) as Record<FundamentalField, number | null>,
  }));
}

export async function countStockScreenerMatches(conditions: ScreenerCondition[], market: "TW" | "US" | null): Promise<number> {
  const marketClause = market === "TW" || market === "US" ? `AND s.country = '${market}'` : "";
  const where = buildWhere(conditions);
  const neededFields = new Set(conditions.filter((c): c is Extract<ScreenerCondition, { field: FundamentalField }> => isFundamentalField(c.field)).map((c) => c.field));
  const fundamentalJoins = buildFundamentalJoins(neededFields);
  const needsPeFallback = neededFields.has("pe");
  const sql = `SELECT count(*)::int n
       FROM stocks s
       CROSS JOIN LATERAL (
         SELECT * FROM stock_technical st WHERE st.stock_id = s.id ORDER BY st.date DESC LIMIT 1
       ) t
       ${fundamentalJoins}
      WHERE s.is_active ${marketClause} ${where}`.replace("$pe_fallback", "$1");
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(sql, ...(needsPeFallback ? [PE_FALLBACK_METRICS] : []));
  return rows[0]?.n ?? 0;
}
