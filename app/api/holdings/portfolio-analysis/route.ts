// Read-only portfolio look-through. GET ?mode=AMOUNT|WEIGHT&items=ETF:<id>:<value>,FUND:<id>:<value>[,…] (max 10)
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildPortfolioAnalysis, parsePortfolioParams } from "@/lib/holdings/portfolioAnalysis";

export async function GET(request: NextRequest) {
  const parsed = parsePortfolioParams(request.nextUrl.searchParams.get("items"), request.nextUrl.searchParams.get("mode"));
  if ("error" in parsed) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  return NextResponse.json(await buildPortfolioAnalysis(prisma, parsed.items, parsed.mode));
}
