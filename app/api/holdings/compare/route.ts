// Read-only 2–4 product ETF/Fund comparison (mixed allowed). GET ?items=ETF:<id>,FUND:<id>[,…]
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildCompare, parseCompareRefs } from "@/lib/holdings/compareService";

export async function GET(request: NextRequest) {
  const refs = parseCompareRefs(request.nextUrl.searchParams.get("items"));
  if ("error" in refs) return NextResponse.json({ ok: false, error: refs.error }, { status: 400 });
  return NextResponse.json(await buildCompare(prisma, refs));
}
