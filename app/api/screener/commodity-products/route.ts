// 商品反查 (item 3) — given a commodity, returns the TW-listed ETFs that directly track it (see
// lib/data-platform/commodityEtfMapping.ts for the curated, name-derived mapping and its scope
// limits). Enriches each with live price/return data already in `etfs` — no self-computed figures.
import { prisma } from "@/lib/prisma";
import { COMMODITY_ETF_MAPPING, COMMODITY_KEYS, THEMATIC_COMMODITY_FUNDS, type CommodityKey } from "@/lib/data-platform/commodityEtfMapping";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

// WTI/Brent crude are both energy-sector exposures -- 能源主題基金 (equity/bond funds investing in
// the energy sector, not direct futures) are shown alongside them for that reason; GOLD only shows
// gold-themed funds; 原物料(BROAD_COMMODITY)-themed funds are shown for every commodity since they
// don't target one specific one.
const THEME_FOR_COMMODITY: Record<CommodityKey, Array<"GOLD" | "ENERGY" | "BROAD_COMMODITY">> = {
  GOLD: ["GOLD", "BROAD_COMMODITY"],
  SILVER: ["BROAD_COMMODITY"],
  WTI_CRUDE: ["ENERGY", "BROAD_COMMODITY"],
  BRENT_CRUDE: ["ENERGY", "BROAD_COMMODITY"],
  COPPER: ["BROAD_COMMODITY"],
  SOYBEANS: ["BROAD_COMMODITY"],
};

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

  const themes = THEME_FOR_COMMODITY[commodity as CommodityKey];
  const thematicEntries = THEMATIC_COMMODITY_FUNDS.filter((f) => themes.includes(f.theme));
  const thematicFundRows = thematicEntries.length
    ? await prisma.fund.findMany({ where: { code: { in: thematicEntries.map((f) => f.code) } }, select: { code: true, name: true, id: true, isActive: true, latestNav: true, latestNavDate: true } })
    : [];
  const thematicByCode = new Map(thematicFundRows.map((r) => [r.code, r]));
  const thematicFunds = thematicEntries.map((e) => {
    const row = thematicByCode.get(e.code);
    return {
      code: e.code, name: e.name, theme: e.theme,
      id: row?.id ?? null, isActive: row?.isActive ?? null,
      latestNav: row?.latestNav ? Number(row.latestNav) : null, navDate: row?.latestNavDate ?? null,
      exposureNote: "間接曝險（投資該產業股票/債券的主題型基金，非直接持有商品期貨）",
    };
  });

  return Response.json({
    ok: true, commodity, total: results.length, generated_at: new Date().toISOString(),
    results,
    thematicFunds,
    scopeNote: "複委託可買的海外商品ETF（如SPDR Gold Shares等）不在本資料庫中（沒有「可複委託交易」的清單或旗標），本端點無法涵蓋，不是遺漏。",
  }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
