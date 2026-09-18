// Read-only holdings table: security name / ticker, weight, holdings date, source, and an explicit
// coverage_depth + is_full_holdings flag so a caller can never mistake a Top-10/partial list for the
// complete portfolio. type is "etf" or "fund"; id is etfs.id or funds.id.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEtfHoldingsTableAsOf, getFundHoldingsTableAsOf } from "@/lib/holdings/holdingsQueries";

export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await params;
  const kind = type.toLowerCase();
  if (kind !== "etf" && kind !== "fund") {
    return NextResponse.json({ ok: false, error: "INVALID_TYPE — expected 'etf' or 'fund'" }, { status: 400 });
  }
  const asOfDate = request.nextUrl.searchParams.get("asOfDate") ?? undefined;

  const view = kind === "etf"
    ? await getEtfHoldingsTableAsOf(prisma, id, asOfDate)
    : await getFundHoldingsTableAsOf(prisma, id, asOfDate);

  return NextResponse.json({
    ok: true,
    productType: kind.toUpperCase(),
    productId: view.productId,
    asOfDate: view.asOfDate,
    source: view.source,
    coverageDepth: view.coverage.coverage_depth,
    isFullHoldings: view.coverage.is_full_holdings,
    holdingCount: view.coverage.holding_count,
    // Explicit, always-present flag — never rely on the client inferring incompleteness from the
    // depth label alone.
    incompleteDataWarning: !view.coverage.is_full_holdings,
    rows: view.rows.map((r) => ({ key: r.key, name: r.name, ticker: r.ticker, weightPct: r.weightPct, sector: r.sector ?? null, country: r.country ?? null })),
  });
}
