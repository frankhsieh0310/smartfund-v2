import { NextRequest, NextResponse } from "next/server";
import { getEtfDetail } from "../../../../lib/data-platform/web/etfService.ts";
import { WebDataError } from "../../../../lib/data-platform/web/errors.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const response = await getEtfDetail(decodeURIComponent(id).trim());
    return NextResponse.json(response, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof WebDataError) {
      const status = error.code === "NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ data: null, meta: null, pagination: null, error: { code: error.code, message: error.message } }, { status });
    }
    return NextResponse.json({ data: null, meta: null, pagination: null, error: { code: "INTERNAL_ERROR", message: "ETF data is temporarily unavailable." } }, { status: 500 });
  }
}
