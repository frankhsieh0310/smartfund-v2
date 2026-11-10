// 持股配對 — 原本規劃好的核心功能（2026-11-11 使用者核准補做）。使用者選1~10檔股票（台股/海外
// 皆可），找出持股最接近的ETF／基金。完全沿用既有持股反查資料（reverse_current_positions /
// reverse_current_securities），不新增後端資料抓取；同商品去重已經在refresh_reverse_products()
// 內完成，這裡讀表就是去重後的結果。
//
// 刻意不改既有 /api/mobile/reverse-holdings（lib/data-platform/reverseIndex.ts 的
// currentReverseHoldings）——那支只回傳每個商品「跨所有選股的matched_count/weight彙總」，沒有
// 逐檔選股各自比重的拆解，但那支已經有排行中心/反查頁在用，風險太高不值得為了這個新功能去改。
// 這裡是獨立、自己的小聚合查詢，排序規則照使用者規格：
//   1. 只選1檔：依持股比重排序（matched_count固定是0或1，退化成純weight排序）
//   2. 選多檔：先依符合的股票數量DESC，再依符合股票的持股比重合計DESC
import { Pool } from "pg";

export const preferredRegion = "sin1";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: "holdings-matcher-read" });
pool.on("error", () => console.error("holdings-matcher read idle connection failed"));

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const MAX_TICKERS = 10;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const requested = [...new Set((q.get("tickers") ?? "").split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_TICKERS);
  if (!requested.length) return Response.json({ ok: false, error: "INVALID_TICKERS" }, { status: 400, headers });

  const page = Math.max(1, Number(q.get("page") ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.get("limit") ?? 50) || 50));
  const offset = (page - 1) * limit;

  try {
    const client = await pool.connect();
    try {
      // 解析每一個使用者輸入的代號對應到哪個security（跟currentReverseHoldings同一套bare/ticker
      // 比對；輸入不乾淨或撞號就列進unmatched，不猜）。
      const resolved = await client.query(
        `SELECT r.requested, s.id stock_id, s.bare, s.ticker, s.country, s.name,
                dense_rank() OVER (PARTITION BY r.requested ORDER BY (s.ticker = r.requested) DESC) priority
           FROM unnest($1::text[]) r(requested)
           JOIN reverse_current_securities s ON (s.ticker = r.requested OR s.bare = r.requested)`,
        [requested],
      );
      const byRequested = new Map<string, typeof resolved.rows>();
      for (const row of resolved.rows) {
        const list = byRequested.get(row.requested) ?? [];
        list.push(row);
        byRequested.set(row.requested, list);
      }
      const unmatched: string[] = [];
      const targets: { requested: string; stockId: string; bare: string; ticker: string; country: string; name: string }[] = [];
      for (const req of requested) {
        // pg回傳dense_rank()（bigint）是字串，不是number，嚴格比對===1永遠不成立。
        const candidates = (byRequested.get(req) ?? []).filter((r) => Number(r.priority) === 1);
        if (candidates.length !== 1) { unmatched.push(req); continue; }
        const c = candidates[0];
        targets.push({ requested: req, stockId: c.stock_id, bare: c.bare, ticker: c.ticker, country: c.country, name: c.name });
      }
      if (!targets.length) {
        return Response.json({ ok: true, matched: [], unmatched, total: 0, page, limit, hasMore: false, basisNote: "本程式計算：依既有持股反查資料找出持股最接近所選股票的ETF／基金，同商品只計一次。" }, { headers });
      }

      const stockIds = targets.map((t) => t.stockId);
      const totalRow = await client.query(
        `SELECT count(*) n FROM (SELECT product_key FROM reverse_current_positions WHERE stock_id = ANY($1::text[]) GROUP BY product_key) t`,
        [stockIds],
      );
      const total = Number(totalRow.rows[0]?.n ?? 0);

      const rows = await client.query(
        `SELECT
            p.product_key, p.type, p.asset_id, p.code, p.name, p.coverage,
            count(DISTINCT p.stock_id) matched_count,
            sum(p.weight) total_weight,
            max(p.date) as_of_date,
            jsonb_agg(jsonb_build_object('stockId', p.stock_id, 'weight', p.weight) ORDER BY p.weight DESC) per_stock
          FROM reverse_current_positions p
         WHERE p.stock_id = ANY($1::text[])
         GROUP BY p.product_key, p.type, p.asset_id, p.code, p.name, p.coverage
         ORDER BY matched_count DESC, total_weight DESC, p.name ASC
         LIMIT $2 OFFSET $3`,
        [stockIds, limit, offset],
      );

      const stockLookup = new Map(targets.map((t) => [t.stockId, t]));
      const matched = rows.rows.map((r) => ({
        productKey: r.product_key as string,
        type: r.type as "ETF" | "基金",
        assetId: r.asset_id as string,
        code: r.code as string,
        name: r.name as string,
        coverage: r.coverage as string | null,
        matchedCount: Number(r.matched_count),
        totalWeightPct: r.total_weight != null ? Number(r.total_weight) : null,
        asOfDate: r.as_of_date ? new Date(r.as_of_date).toISOString().slice(0, 10) : null,
        matchedStocks: (r.per_stock as Array<{ stockId: string; weight: number | null }>).map((m) => {
          const t = stockLookup.get(m.stockId);
          return { bare: t?.bare ?? "", ticker: t?.ticker ?? "", name: t?.name ?? "", weightPct: m.weight };
        }),
      }));

      return Response.json(
        {
          ok: true,
          matched,
          unmatched,
          total,
          page,
          limit,
          hasMore: offset + matched.length < total,
          basisNote: "本程式計算：依既有持股反查資料找出持股最接近所選股票的ETF／基金，同商品只計一次。",
        },
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
