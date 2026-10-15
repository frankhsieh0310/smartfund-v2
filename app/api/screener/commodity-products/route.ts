// 商品反查 (item 3) — given a commodity, returns the TW-listed ETFs that directly track it (see
// lib/data-platform/commodityEtfMapping.ts for the curated, name-derived mapping and its scope
// limits). Enriches each with live price/return data already in `etfs` — no self-computed figures.
import { prisma } from "@/lib/prisma";
import { COMMODITY_ETF_MAPPING, COMMODITY_KEYS, type CommodityKey } from "@/lib/data-platform/commodityEtfMapping";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const commodity = q.get("commodity");
  if (!commodity) {
    return Response.json({ ok: true, availableCommodities: COMMODITY_KEYS }, { headers });
  }
  if (!COMMODITY_KEYS.includes(commodity as CommodityKey)) {
    return Response.json({ ok: false, error: "UNKNOWN_COMMODITY", availableCommodities: COMMODITY_KEYS }, { status: 400, headers });
  }
  const entries = COMMODITY_ETF_MAPPING.filter((e) => e.commodity === commodity);
  const codes = entries.map((e) => e.code);
  const rows = await prisma.etf.findMany({
    where: { code: { in: codes } },
    select: { code: true, name: true, id: true, isActive: true, latestPrice: true, priceUpdatedAt: true, returnYtd: true, return1y: true },
  });
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const results = entries.map((e) => {
    const row = byCode.get(e.code);
    return {
      code: e.code,
      name: e.name,
      direction: e.direction,
      leverage: e.leverage,
      id: row?.id ?? null,
      isActive: row?.isActive ?? null,
      latestPrice: row?.latestPrice ? Number(row.latestPrice) : null,
      priceDate: row?.priceUpdatedAt ?? null,
      returnYtdPct: row?.returnYtd ? Number(row.returnYtd) : null,
      return1YPct: row?.return1y ? Number(row.return1y) : null,
    };
  });
  return Response.json({ ok: true, commodity, total: results.length, generated_at: new Date().toISOString(), results }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
