// Read-only distribution / cash-flow estimate from real distribution history.
// GET ?mode=SHARES|AMOUNT&items=ETF:<id>:<shares|amount>,FUND:<id>:<value>[,…] (max 10)
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildCashflowEstimate, parseCashflowParams } from "@/lib/cashflow/estimate";

export async function GET(request: NextRequest) {
  const parsed = parseCashflowParams(request.nextUrl.searchParams.get("items"), request.nextUrl.searchParams.get("mode"));
  if ("error" in parsed) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  return NextResponse.json(await buildCashflowEstimate(prisma, parsed.items, parsed.mode));
}
