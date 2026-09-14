import { getGovernmentYieldContracts, listGovernmentYieldSeries } from "@/lib/services/governmentYieldService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  if (parameters.get("mode") === "contracts") return Response.json(await getGovernmentYieldContracts());
  const filters = Object.fromEntries(["query", "jurisdiction", "currency", "tenor", "curveType", "authority", "officialSource"].map((key) => [key, parameters.get(key)]));
  const data = await listGovernmentYieldSeries(filters);
  return Response.json({ canonicalTruth: "OFFICIAL_57_SERIES_PRODUCT", data, total: data.length });
}
