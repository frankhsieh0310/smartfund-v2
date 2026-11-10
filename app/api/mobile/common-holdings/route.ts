// 基金共同持股排行 — 原本規劃好的核心功能，之前被名稱蓋掉、沒有真正做出來（見 2026-11-10
// 使用者核准指令）。完全沿用既有持股反查資料（reverse_current_positions / reverse_current_securities），
// 不新增任何後端資料抓取；dedup（同商品ETF/基金重複只算一次）已經在 refresh_reverse_products()
// 內完成，這裡直接讀表就是去重後的結果，不用再處理一次。
import { Pool } from "pg";

export const preferredRegion = "sin1";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: "common-holdings-read" });
pool.on("error", () => console.error("common-holdings read idle connection failed"));

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

type Scope = "TW" | "GLOBAL";
type ProductFilter = "ALL" | "ETF" | "FUND";
type SortKey = "count" | "weight";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const scope: Scope = q.get("scope") === "GLOBAL" ? "GLOBAL" : "TW";
  const productFilterRaw = (q.get("productType") ?? "ALL").toUpperCase();
  const productFilter: ProductFilter = productFilterRaw === "ETF" || productFilterRaw === "FUND" ? (productFilterRaw as ProductFilter) : "ALL";
  const sort: SortKey = q.get("sort") === "weight" ? "weight" : "count";
  const page = Math.max(1, Number(q.get("page") ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.get("limit") ?? 50) || 50));
  const offset = (page - 1) * limit;

  const typeFilterSql = productFilter === "ETF" ? "AND p.type = 'ETF'" : productFilter === "FUND" ? "AND p.type = '基金'" : "";
  const countrySql = scope === "TW" ? "AND s.country = 'TW'" : "AND s.country <> 'TW'";

  try {
    const client = await pool.connect();
    try {
      const totalRow = await client.query(
        `SELECT count(*) n FROM (
           SELECT p.stock_id
             FROM reverse_current_positions p JOIN reverse_current_securities s ON s.id = p.stock_id
            WHERE 1=1 ${countrySql} ${typeFilterSql}
            GROUP BY p.stock_id
         ) t`,
      );
      const total = Number(totalRow.rows[0]?.n ?? 0);

      const sortSql = sort === "weight" ? "avg_weight DESC NULLS LAST" : "total_count DESC";
      const rows = await client.query(
        `SELECT
            s.id stock_id, s.bare, s.ticker, s.country, s.name,
            count(DISTINCT CASE WHEN p.type = 'ETF' THEN p.product_key END) etf_count,
            count(DISTINCT CASE WHEN p.type = '基金' THEN p.product_key END) fund_count,
            count(DISTINCT p.product_key) total_count,
            avg(p.weight) avg_weight,
            max(p.date) as_of_date
          FROM reverse_current_positions p JOIN reverse_current_securities s ON s.id = p.stock_id
         WHERE 1=1 ${countrySql} ${typeFilterSql}
         GROUP BY s.id, s.bare, s.ticker, s.country, s.name
         ORDER BY ${sortSql}, s.bare ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );

      const results = rows.rows.map((r) => ({
        stockId: r.stock_id as string,
        bare: r.bare as string,
        ticker: r.ticker as string,
        country: r.country as string,
        name: r.name as string,
        etfCount: Number(r.etf_count),
        fundCount: Number(r.fund_count),
        totalCount: Number(r.total_count),
        avgWeightPct: r.avg_weight != null ? Number(r.avg_weight) : null,
        asOfDate: r.as_of_date ? new Date(r.as_of_date).toISOString().slice(0, 10) : null,
      }));

      return Response.json(
        { ok: true, scope, productType: productFilter, sort, page, limit, total, hasMore: offset + results.length < total, results, basisNote: "本程式計算：依既有持股反查資料統計，每檔股票被持有的ETF/基金檔數與平均持股比重；同一商品（例如上市ETF與其SITCA基金登記）只計一次。" },
        { headers },
      );
    } finally {
      client.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "QUERY_FAILED";
    return Response.json({ ok: false, error: message }, { status: 500, headers });
  }
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
