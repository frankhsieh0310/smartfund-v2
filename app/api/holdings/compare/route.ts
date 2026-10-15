import { compareEtfFund, type CompareKind, type CompareRef } from "@/lib/data-platform/holdingsCompare";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const MAX_ITEMS = 4;

function parseItems(param: string | null): CompareRef[] | null {
  if (!param) return null;
  const parts = param.split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_ITEMS);
  const refs: CompareRef[] = [];
  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx === -1) return null;
    const assetType = part.slice(0, idx).toUpperCase();
    const id = part.slice(idx + 1);
    if ((assetType !== "ETF" && assetType !== "FUND") || !id) return null;
    refs.push({ assetType: assetType as CompareKind, id: decodeURIComponent(id) });
  }
  return refs;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const refs = parseItems(url.searchParams.get("items"));
  if (!refs || refs.length === 0) {
    return Response.json({ ok: false, error: "INVALID_ITEMS", hint: "items=ETF:<id>,FUND:<id> (max 4)" }, { status: 400, headers });
  }
  const result = await compareEtfFund(refs);
  return Response.json(result, { headers });
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
