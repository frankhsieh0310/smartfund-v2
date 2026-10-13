import { getLatestSnapshot, coverageDepthOf, type ProductType } from "@/lib/data-platform/holdingsHistory";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export async function GET(_req: Request, context: RouteContext<"/api/holdings/[type]/[id]/table">) {
  const { type, id } = await context.params;
  const productType = type.toUpperCase() === "ETF" ? "ETF" : type.toUpperCase() === "FUND" ? "FUND" : null;
  if (!productType || !id) return Response.json({ ok: false, error: "INVALID_PRODUCT" }, { status: 400, headers });

  const snapshot = await getLatestSnapshot(productType as ProductType, id);
  if (!snapshot) {
    return Response.json({
      ok: true, productType, productId: id, asOfDate: null, source: null,
      coverageDepth: "UNKNOWN", isFullHoldings: false, holdingCount: null,
      incompleteDataWarning: true, rows: [],
    }, { headers });
  }
  const coverageDepth = coverageDepthOf(snapshot.source);
  return Response.json({
    ok: true, productType, productId: id, asOfDate: snapshot.asOfDate, source: snapshot.source,
    coverageDepth, isFullHoldings: coverageDepth === "FULL", holdingCount: snapshot.rows.length,
    incompleteDataWarning: coverageDepth !== "FULL",
    rows: snapshot.rows.map((r) => ({ key: r.key, name: r.name, ticker: r.ticker, weightPct: r.weightPct, sector: r.sector, country: r.country })),
  }, { headers });
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
