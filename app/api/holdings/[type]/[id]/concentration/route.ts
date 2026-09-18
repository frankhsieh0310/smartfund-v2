// Read-only concentration analysis (Top 10 / Top 20 / largest single holding / sector / country),
// computed from whatever holdings data is currently available for this product — never blocked on
// full-universe coverage. When the underlying holdings aren't FULL, the response says so explicitly
// so a caller never presents a Top-10-derived concentration figure as if it were exhaustive.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeConcentration } from "@/lib/holdings/concentration";
import { getEtfHoldingsTableAsOf, getFundHoldingsTableAsOf } from "@/lib/holdings/holdingsQueries";

// Same cross-origin allowance as app/api/mobile/assets/[assetId]/route.ts — this route is read
// by the SmartMatch mobile app from a different origin (Expo web / native), not just this web app.
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }

export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await params;
  const kind = type.toLowerCase();
  if (kind !== "etf" && kind !== "fund") {
    return NextResponse.json({ ok: false, error: "INVALID_TYPE — expected 'etf' or 'fund'" }, { status: 400, headers: corsHeaders });
  }
  const asOfDate = request.nextUrl.searchParams.get("asOfDate") ?? undefined;

  const view = kind === "etf"
    ? await getEtfHoldingsTableAsOf(prisma, id, asOfDate)
    : await getFundHoldingsTableAsOf(prisma, id, asOfDate);

  const concentration = computeConcentration(view.rows);

  return NextResponse.json({
    ok: true,
    productType: kind.toUpperCase(),
    productId: view.productId,
    asOfDate: view.asOfDate,
    coverageDepth: view.coverage.coverage_depth,
    isFullHoldings: view.coverage.is_full_holdings,
    // Required disclaimer whenever the underlying data isn't the complete portfolio.
    basisNote: view.coverage.is_full_holdings
      ? "基於完整持股計算"
      : "依目前可取得持股計算（非完整持股，實際集中度可能不同）",
    top10Pct: concentration.top10Pct,
    top20Pct: concentration.top20Pct,
    largestHolding: concentration.largestHolding,
    sectorConcentration: concentration.sectorConcentration,
    countryConcentration: concentration.countryConcentration,
  }, { headers: corsHeaders });
}
