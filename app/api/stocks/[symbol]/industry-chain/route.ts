import { NextResponse } from "next/server";
import { getStockIndustryChain } from "@/lib/data-platform/industry-chain/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: RouteContext<"/api/stocks/[symbol]/industry-chain">) {
  const { symbol } = await context.params;
  return NextResponse.json(await getStockIndustryChain(decodeURIComponent(symbol)), { headers: { "Cache-Control": "private, max-age=300" } });
}
