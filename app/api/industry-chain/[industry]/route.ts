import { NextResponse } from "next/server";
import { getIndustryChain } from "@/lib/data-platform/industry-chain/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: RouteContext<"/api/industry-chain/[industry]">) {
  const { industry } = await context.params;
  const result = await getIndustryChain(decodeURIComponent(industry));
  return result ? NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=300" } }) : NextResponse.json({ error: "Industry chain not found" }, { status: 404 });
}
