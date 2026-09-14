import { NextRequest, NextResponse } from "next/server";
import { getFundDetail, type FundDetailRange } from "../../../../lib/data-platform/web/fundService.ts";
import { WebDataError } from "../../../../lib/data-platform/web/errors.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ranges = new Set<FundDetailRange>(["1M", "3M", "6M", "1Y", "3Y", "5Y", "MAX"]);

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const requestedRange = (request.nextUrl.searchParams.get("range") ?? "1Y").toUpperCase() as FundDetailRange;
    if (!ranges.has(requestedRange)) {
      throw new WebDataError("INVALID_QUERY", "Unsupported fund history range.");
    }
    const response = await getFundDetail(id, 20, requestedRange);
    return NextResponse.json(response, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof WebDataError) {
      const status = error.code === "NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ data: null, meta: null, pagination: null, error: { code: error.code, message: error.message } }, { status });
    }
    return NextResponse.json({ data: null, meta: null, pagination: null, error: { code: "INTERNAL_ERROR", message: "Fund data is temporarily unavailable." } }, { status: 500 });
  }
}
