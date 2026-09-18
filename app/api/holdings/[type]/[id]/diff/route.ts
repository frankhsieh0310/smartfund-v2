// Read-only historical holdings diff: latest recorded snapshot vs the one immediately before it.
// Dates are always the source-effective date already stored per snapshot (etf_holding_snapshots
// .effective_date, or the fund holdings row's own as_of_date) — never a fetch/ingestion timestamp.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEtfHoldingsDiffLatestVsPrevious, getFundHoldingsDiffLatestVsPrevious } from "@/lib/holdings/holdingsQueries";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await params;
  const kind = type.toLowerCase();
  if (kind !== "etf" && kind !== "fund") {
    return NextResponse.json({ ok: false, error: "INVALID_TYPE — expected 'etf' or 'fund'" }, { status: 400 });
  }

  const diff = kind === "etf"
    ? await getEtfHoldingsDiffLatestVsPrevious(prisma, id)
    : await getFundHoldingsDiffLatestVsPrevious(prisma, id);

  if (!diff.hasEnoughHistory) {
    return NextResponse.json({
      ok: true,
      productType: kind.toUpperCase(),
      productId: diff.productId,
      hasEnoughHistory: false,
      reason: "NEEDS_AT_LEAST_TWO_DATED_SNAPSHOTS",
      previousDate: diff.previousDate,
      latestDate: diff.latestDate,
      added: [], increased: [], decreased: [], removed: [],
    });
  }

  const added = diff.entries.filter((e) => e.change === "ADDED");
  const increased = diff.entries.filter((e) => e.change === "INCREASED");
  const decreased = diff.entries.filter((e) => e.change === "DECREASED");
  const removed = diff.entries.filter((e) => e.change === "REMOVED");

  return NextResponse.json({
    ok: true,
    productType: kind.toUpperCase(),
    productId: diff.productId,
    hasEnoughHistory: true,
    previousDate: diff.previousDate, // source-effective date, not fetch time
    latestDate: diff.latestDate,
    added, increased, decreased, removed,
    summary: { addedCount: added.length, increasedCount: increased.length, decreasedCount: decreased.length, removedCount: removed.length },
  });
}
