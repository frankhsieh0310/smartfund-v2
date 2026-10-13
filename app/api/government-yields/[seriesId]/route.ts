import { getGovernmentYieldDetail } from "@/lib/services/governmentYieldService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ seriesId: string }> }) {
  const { seriesId } = await params;
  const data = await getGovernmentYieldDetail(seriesId);
  return data ? Response.json({ data }) : Response.json({ error: "GOVERNMENT_YIELD_SERIES_NOT_FOUND" }, { status: 404 });
}
