import { NextResponse } from "next/server";
import { cacheControlFor, errorResponse, getStockDetail } from "@/lib/data-platform/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: RouteContext<"/api/stocks/[symbol]">) {
  try {
    const { symbol } = await context.params;
    const result = await getStockDetail(symbol);
    return NextResponse.json(result, { headers: { "Cache-Control": cacheControlFor("MARKET") } });
  } catch (error) {
    const response = errorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
