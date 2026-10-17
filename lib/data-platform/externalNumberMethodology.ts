// 2026-10-18 固定範圍第 7 項 (對外數字口徑): the standard methodology for any public-facing number
// like "台積電被 X 檔持有" (how many funds/ETFs hold a given stock). Four rules, all already true of
// the underlying data except the first:
//   1. Split by 台灣買得到 vs 買不到 (uses tw_purchasable_classification, built for item 1).
//   2. ETF and FUND counted separately (already true of reverseHoldings.ts's etf_total_products /
//      fund_total_products).
//   3. Same fund's different share classes not double-counted (already true: fund_batches groups by
//      coalesce(sc.master_fund_id, f.id), see lib/data-platform/reverseHoldings.ts).
//   4. Data date shown (already true: each product carries its own `date`).
// This module adds (1) as a lightweight enrichment over the existing reverse-holdings result --
// deliberately NOT touching reverseHoldings.ts/reverseIndex.ts's own SQL, which is a carefully
// tuned, already-verified-correct precomputed-index query; a wrong edit there risks breaking a
// working system for a narrower, lower-risk addition applied with Prisma instead.
import type { Query } from "./reverseHoldings";

export const METHODOLOGY_VERSION = "2026-10-18.1";

export type PurchasableStatus = "APPROVED" | "NOT_APPROVED" | "UNKNOWN";
export type HeldByProduct = { id: string; code: string; name: string; type: "ETF" | "基金"; assetId: string; date: string | null };
export type HeldByBreakdown = {
  etf: { approved: number; notApproved: number; unknown: number };
  fund: { approved: number; notApproved: number; unknown: number };
};

/** Looks up tw_purchasable_classification for a set of reverse-holdings products, keyed correctly
 * per type: ETF products carry their CODE as assetId (see reverseHoldings.ts's `e.code asset_id`),
 * so ETF classification is joined via etfs.code -> etfs.id; FUND products already carry the real
 * funds.id as assetId, joined directly. */
export async function classifyHeldByProducts(
  query: Query,
  products: HeldByProduct[],
): Promise<{ breakdown: HeldByBreakdown; statusByProductId: Map<string, PurchasableStatus> }> {
  const etfCodes = [...new Set(products.filter((p) => p.type === "ETF").map((p) => p.assetId))];
  const fundIds = [...new Set(products.filter((p) => p.type === "基金").map((p) => p.assetId))];

  const etfRows = etfCodes.length
    ? await query<{ code: string; status: string | null }>(
        `SELECT e.code, c.status FROM etfs e LEFT JOIN tw_purchasable_classification c ON c.asset_type = 'ETF' AND c.asset_id = e.id::text WHERE e.code = ANY($1::text[])`,
        etfCodes,
      )
    : [];
  const fundRows = fundIds.length
    ? await query<{ id: string; status: string | null }>(
        `SELECT id::text, status FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND asset_id = ANY($1::text[])`,
        fundIds,
      )
    : [];

  const etfStatusByCode = new Map(etfRows.map((r) => [r.code, (r.status ?? "UNKNOWN") as PurchasableStatus]));
  const fundStatusById = new Map(fundRows.map((r) => [r.id, (r.status ?? "UNKNOWN") as PurchasableStatus]));

  const breakdown: HeldByBreakdown = { etf: { approved: 0, notApproved: 0, unknown: 0 }, fund: { approved: 0, notApproved: 0, unknown: 0 } };
  const statusByProductId = new Map<string, PurchasableStatus>();
  for (const p of products) {
    const status = p.type === "ETF" ? (etfStatusByCode.get(p.assetId) ?? "UNKNOWN") : (fundStatusById.get(p.assetId) ?? "UNKNOWN");
    statusByProductId.set(p.id, status);
    const bucket = p.type === "ETF" ? breakdown.etf : breakdown.fund;
    if (status === "APPROVED") bucket.approved++;
    else if (status === "NOT_APPROVED") bucket.notApproved++;
    else bucket.unknown++;
  }
  return { breakdown, statusByProductId };
}

/** Full-set (NOT paginated) 台灣買得到／買不到 breakdown for a "held by N funds/ETFs" style public
 * number. The route's own paginated `results` (default limit 50) would silently undercount a
 * popular stock held by hundreds of products (e.g. 2330 TSMC: 614 ETFs + 962 funds, far over the
 * default page) -- this queries `reverse_current_positions` (the same precomputed index
 * currentReverseHoldings reads, see lib/data-platform/reverseIndex.ts) directly for every DISTINCT
 * matched product, independent of ranking/pagination, so the published count is the real total. */
export async function computeTwPurchasableBreakdownFull(
  query: Query,
  tickers: string[],
  market = "",
): Promise<HeldByBreakdown & { totalEtf: number; totalFund: number }> {
  const requested = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  if (!requested.length) throw new Error("INVALID_TICKERS");
  const rows = await query<{ type: "ETF" | "基金"; code: string; asset_id: string }>(
    `WITH candidates AS (
       SELECT r.requested, s.id, s.ticker, s.bare, s.country,
         dense_rank() OVER (PARTITION BY r.requested ORDER BY (s.ticker = r.requested) DESC) priority
       FROM unnest($1::text[]) r(requested)
       JOIN reverse_current_securities s ON (s.ticker = r.requested OR s.bare = r.requested) AND ($2 = '' OR s.country = $2)
     ), selected AS (
       SELECT DISTINCT id FROM candidates WHERE priority = 1
     )
     SELECT DISTINCT p.type, p.code, p.asset_id
       FROM selected sel JOIN reverse_current_positions p ON p.stock_id = sel.id`,
    requested,
    market,
  );
  const products: HeldByProduct[] = rows.map((r, i) => ({ id: `${r.type}:${r.code}:${i}`, code: r.code, name: r.code, type: r.type, assetId: r.asset_id, date: null }));
  const { breakdown } = await classifyHeldByProducts(query, products);
  return { ...breakdown, totalEtf: products.filter((p) => p.type === "ETF").length, totalFund: products.filter((p) => p.type === "基金").length };
}

/** Records one computed public-facing number for audit purposes. Fire-and-forget is NOT used here
 * deliberately -- a failed audit write should be visible, not silently dropped, since the whole
 * point is traceability. */
export async function recordExternalNumberAudit(
  query: Query,
  input: { metricKey: string; inputParams: unknown; result: unknown; computedBy: string; notes?: string },
): Promise<void> {
  await query(
    `INSERT INTO external_number_audit_log (metric_key, methodology_version, input_params, result, computed_by, notes) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)`,
    input.metricKey,
    METHODOLOGY_VERSION,
    JSON.stringify(input.inputParams),
    JSON.stringify(input.result),
    input.computedBy,
    input.notes ?? null,
  );
}
