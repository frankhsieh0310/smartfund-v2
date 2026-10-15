import { computePortfolioLookThrough, type AllocationMode, type SelectedProductInput } from "@/lib/data-platform/portfolioLookThrough";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const MAX_ITEMS = 10;

function parseItems(param: string | null): SelectedProductInput[] | null {
  if (!param) return null;
  const parts = param.split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_ITEMS);
  const items: SelectedProductInput[] = [];
  for (const part of parts) {
    const segs = part.split(":");
    if (segs.length !== 3) return null;
    const [typeRaw, idRaw, valueRaw] = segs;
    const assetType = typeRaw.toUpperCase();
    const value = Number(valueRaw);
    if ((assetType !== "ETF" && assetType !== "FUND") || !idRaw || !Number.isFinite(value)) return null;
    items.push({ assetType: assetType as "ETF" | "FUND", id: decodeURIComponent(idRaw), value });
  }
  return items;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const modeRaw = (url.searchParams.get("mode") ?? "WEIGHT").toUpperCase();
  const mode: AllocationMode = modeRaw === "AMOUNT" ? "AMOUNT" : "WEIGHT";
  const items = parseItems(url.searchParams.get("items"));
  if (!items || items.length === 0) {
    return Response.json({ ok: false, error: "INVALID_ITEMS", hint: "items=ETF:<id>:<value>,FUND:<id>:<value> (max 10)" }, { status: 400, headers });
  }
  const result = await computePortfolioLookThrough(items, mode);
  return Response.json(result, { headers });
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
