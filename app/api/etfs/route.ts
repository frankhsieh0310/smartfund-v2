import { NextRequest, NextResponse } from "next/server";
import { cacheControlFor, errorResponse, getEtfList } from "@/lib/data-platform/web";

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams.get("query")?.trim();
    const page = Number(request.nextUrl.searchParams.get("page") ?? "1");
    const pageSize = Number(request.nextUrl.searchParams.get("pageSize") ?? request.nextUrl.searchParams.get("limit") ?? "50");
    const result = await getEtfList({ query, page, pageSize });
    return NextResponse.json(result, { headers: { "Cache-Control": cacheControlFor("MARKET") } });
  } catch (error) {
    const response = errorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
