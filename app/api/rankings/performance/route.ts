// Function 3 (基金 / ETF 排行榜) — real backend ranking over the FULL canonical product universe.
// ETF: etfs table's own return_1m/3m/6m/1y/3y/5y columns (already populated by the existing Yahoo
// pipeline — no new ingestion). Fund: canonical portfolio-deduped (COALESCE(master_fund_id, id), same
// grouping already used by the reverse-lookup engine's fund_batches CTE) over funds.return_1y/3y/5y —
// Fund has no 1m/3m/6m columns in this schema, so those periods are simply not offered for Fund (never
// fabricated). Full-universe sort (ORDER BY ... LIMIT/OFFSET in SQL) before pagination — never a
// partial/page-local sort.
import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

const ETF_PERIOD_COLUMN: Record<string, string> = {
  "1M": "return_1m", "3M": "return_3m", "6M": "return_6m", "1Y": "return_1y", "3Y": "return_3y", "5Y": "return_5y",
};
// Fund schema has no 1m/3m/6m return columns — those periods return an explicit UNSUPPORTED state,
// never a fabricated number.
const FUND_PERIOD_COLUMN: Record<string, string> = { "1Y": "return_1y", "3Y": "return_3y", "5Y": "return_5y" };

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const assetType = q.get("assetType") === "FUND" ? "FUND" : "ETF";
  const period = (q.get("period") ?? "1Y").toUpperCase();
  const sort = q.get("sort") === "asc" ? "ASC" : "DESC";
  const limit = Math.min(100, Math.max(1, Number(q.get("limit") ?? 50)));
  const page = Math.max(1, Number(q.get("page") ?? 1));
  const offset = (page - 1) * limit;

  const columnMap = assetType === "FUND" ? FUND_PERIOD_COLUMN : ETF_PERIOD_COLUMN;
  const column = columnMap[period];
  if (!column) {
    return Response.json({
      assetType, period, supported: false, total: 0, page, limit, hasMore: false, results: [],
      reason: assetType === "FUND" ? "FUND_HAS_NO_1M_3M_6M_RETURN_DATA" : "UNSUPPORTED_PERIOD",
    }, { headers });
  }

  if (assetType === "ETF") {
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string; code: string; name: string; value: string; latest_price: string | null; price_date: string | null;
    }>>(
      `SELECT id, code, name, ${column}::text AS value, latest_price::text, price_updated_at::text AS price_date
         FROM etfs WHERE is_active = true AND ${column} IS NOT NULL
        ORDER BY ${column} ${sort} LIMIT $1 OFFSET $2`,
      limit, offset,
    );
    const totalRow = await prisma.$queryRawUnsafe<Array<{ c: string }>>(
      `SELECT COUNT(*)::text c FROM etfs WHERE is_active = true AND ${column} IS NOT NULL`,
    );
    const total = Number(totalRow[0].c);
    return Response.json({
      assetType, period, supported: true, total, page, limit, hasMore: offset + rows.length < total,
      results: rows.map((r) => ({
        id: r.id, code: r.code, name: r.name, returnPct: Number(r.value),
        price: r.latest_price !== null ? Number(r.latest_price) : null, priceDate: r.price_date,
      })),
    }, { headers });
  }

  // FUND — one row per canonical portfolio (COALESCE(master_fund_id, id)), preferring the fund_master's
  // own representative_fund_id when one exists, else whichever share class has the best return in this
  // sort direction — this is display dedup only (never drops the underlying share-class-level data,
  // it's still queryable via the fund detail route), matching "same product shown once, not twice".
  const rankedRows = await prisma.$queryRawUnsafe<Array<{
    id: string; code: string | null; name: string; value: string; nav: string | null; nav_date: string | null; total: string;
  }>>(
    `WITH ranked AS (
       SELECT f.id, f.code, f.name, f.${column} AS value, f.latest_nav, f.latest_nav_date,
              COALESCE(sc.master_fund_id, f.id) AS portfolio,
              ROW_NUMBER() OVER (
                PARTITION BY COALESCE(sc.master_fund_id, f.id)
                ORDER BY (f.id = fm.representative_fund_id) DESC NULLS LAST, f.${column} ${sort} NULLS LAST
              ) AS rn
         FROM funds f
         LEFT JOIN fund_share_classes sc ON sc.fund_id = f.id
         LEFT JOIN fund_master fm ON fm.id = sc.master_fund_id
        WHERE f.is_active = true AND f.${column} IS NOT NULL
     )
     SELECT id, code, name, value::text, latest_nav::text AS nav, latest_nav_date::text AS nav_date,
            COUNT(*) OVER ()::text AS total
       FROM ranked WHERE rn = 1
      ORDER BY value ${sort} LIMIT $1 OFFSET $2`,
    limit, offset,
  );
  const total = rankedRows.length ? Number(rankedRows[0].total) : 0;
  return Response.json({
    assetType, period, supported: true, total, page, limit, hasMore: offset + rankedRows.length < total,
    results: rankedRows.map((r) => ({
      id: r.id, code: r.code, name: r.name, returnPct: Number(r.value),
      price: r.nav !== null ? Number(r.nav) : null, priceDate: r.nav_date,
    })),
  }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
