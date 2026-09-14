import { NextResponse } from "next/server";
import { getHomeMarketOverview } from "@/lib/data-platform/web/homeMarketService";

export const runtime = "nodejs";

export async function GET() {
  const response = NextResponse.json(await getHomeMarketOverview());
  response.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  return response;
}
