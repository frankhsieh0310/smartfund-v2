// 2026-10-18 修正一: real, data-driven "indirect exposure" for 商品反查 -- replaces the earlier
// (2026-10-17) VERIFIED-infeasible conclusion. That conclusion was correct for the data available at
// the time (stocks.sector/industry empty, holdings.sector only covered bond taxonomy for our then-
// ingested iShares universe) -- the fix here is not a new algorithm, it's capturing an official field
// (iShares CSV's own "Sector" column) that already exists on `holdings.sector` but was only being
// populated for bond ETFs because the ingestion config (config/ishares-bond-etf-products.json) never
// included any equity commodity-theme fund. See config/ishares-commodity-equity-etf-products.json.
//
// Real correctness bugs found and fixed while building this (see scratch investigation, not kept):
// summing `weight` across ALL as_of_date snapshots for an ETF (instead of just the latest) produced
// sums over 100%; and the same "Energy"/"Materials" label is used by iShares BOTH as a bond-sector
// taxonomy value (bond issuer's industry) and a GICS equity-sector value -- conflating them pulled in
// high-yield bond ETFs as false "commodity exposure". Both are excluded here via
// `coupon_rate IS NULL AND maturity_date IS NULL` (bond-specific columns, NULL on equity/cash rows)
// and a latest-snapshot-only CTE.
import type { PrismaClient } from "@prisma/client";

export type SectorCommodityKey = "GOLD" | "SILVER" | "COPPER" | "WTI_CRUDE" | "BRENT_CRUDE";

// GICS equity sector each commodity's related industry falls under, per the iShares CSV's own
// "Sector" column vocabulary (confirmed live: miners/producers funds come back ~99% "Materials",
// the global energy-equity fund ~99% "Energy"). No entry for SOYBEANS/other softs: no equity GICS
// sector cleanly maps to "soybean-related industry" the way Materials maps to miners or Energy maps
// to oil & gas producers -- left out rather than forcing a noisy, honestly-wrong mapping.
export const COMMODITY_SECTOR: Partial<Record<SectorCommodityKey, string>> = {
  GOLD: "Materials",
  SILVER: "Materials",
  COPPER: "Materials",
  WTI_CRUDE: "Energy",
  BRENT_CRUDE: "Energy",
};

const MIN_SECTOR_WEIGHT_PCT = 20;

export type IndirectExposureResult = {
  assetType: "ETF" | "FUND";
  code: string;
  name: string;
  id: string | null;
  sectorWeightPct: number;
  asOfDate: string;
};

export async function findIndirectExposureBySector(
  prisma: PrismaClient,
  commodity: SectorCommodityKey,
): Promise<{ sector: string | null; results: IndirectExposureResult[] }> {
  const sector = COMMODITY_SECTOR[commodity] ?? null;
  if (!sector) return { sector: null, results: [] };

  const etfRows = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; name: string; weight: string; as_of: string }>>(
    `WITH latest AS (SELECT etf_id, max(as_of_date) AS d FROM holdings WHERE asset_type='ETF' GROUP BY etf_id)
     SELECT e.id::text, e.code, e.name, sum(h.weight)::text AS weight, l.d::text AS as_of
       FROM holdings h
       JOIN latest l ON l.etf_id = h.etf_id AND l.d = h.as_of_date
       JOIN etfs e ON e.id = h.etf_id
      WHERE h.asset_type = 'ETF' AND h.sector = $1 AND h.coupon_rate IS NULL AND h.maturity_date IS NULL
      GROUP BY e.id, e.code, e.name, l.d
     HAVING sum(h.weight) > $2
      ORDER BY sum(h.weight) DESC
      LIMIT 10`,
    sector,
    MIN_SECTOR_WEIGHT_PCT,
  );
  const fundRows = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; name: string; weight: string; as_of: string }>>(
    `WITH latest AS (SELECT fund_id, max(as_of_date) AS d FROM holdings WHERE asset_type='FUND' GROUP BY fund_id)
     SELECT f.id::text, f.code, f.name, sum(h.weight)::text AS weight, l.d::text AS as_of
       FROM holdings h
       JOIN latest l ON l.fund_id = h.fund_id AND l.d = h.as_of_date
       JOIN funds f ON f.id = h.fund_id
      WHERE h.asset_type = 'FUND' AND h.sector = $1 AND h.coupon_rate IS NULL AND h.maturity_date IS NULL
      GROUP BY f.id, f.code, f.name, l.d
     HAVING sum(h.weight) > $2
      ORDER BY sum(h.weight) DESC
      LIMIT 10`,
    sector,
    MIN_SECTOR_WEIGHT_PCT,
  );

  const results: IndirectExposureResult[] = [
    ...etfRows.map((r) => ({ assetType: "ETF" as const, code: r.code, name: r.name, id: r.id, sectorWeightPct: Number(r.weight), asOfDate: r.as_of })),
    ...fundRows.map((r) => ({ assetType: "FUND" as const, code: r.code, name: r.name, id: r.id, sectorWeightPct: Number(r.weight), asOfDate: r.as_of })),
  ].sort((a, b) => b.sectorWeightPct - a.sectorWeightPct);

  return { sector, results };
}

// 2026-10-18 修正一 (TW side): TWSE/TPEx's own official industry category (now populated on
// stocks.industry, see scripts/backfill-tw-stock-industry.ts), cross-referenced against TW-listed
// ETF/fund holdings (`holdings.ticker` matches `stocks.ticker` directly, no suffix). Taiwan's own
// 33-category taxonomy has NO mining/precious-metals/agriculture-commodity category at all (VERIFIED
// live: distinct stocks.industry values after the backfill), so GOLD/SILVER/COPPER/SOYBEANS honestly
// have no TW-side mapping -- only 油電燃氣業 (oil/electricity/gas utilities) is a defensible real
// match, for WTI/Brent. VERIFIED live: even that category's highest concentration in our ingested TW
// ETF/fund universe is 5.12% (富邦旗艦50) -- below the same 20% bar used on the global side -- so this
// correctly returns empty today. Real, not hidden: Taiwan's ETF/fund market is broad-market/dividend-
// heavy and doesn't currently have a concentrated oil & gas thematic fund, not a bug in this query.
export const COMMODITY_TW_INDUSTRY: Partial<Record<SectorCommodityKey, string>> = {
  WTI_CRUDE: "油電燃氣業",
  BRENT_CRUDE: "油電燃氣業",
};

export async function findIndirectExposureByTwIndustry(
  prisma: PrismaClient,
  commodity: SectorCommodityKey,
): Promise<{ industry: string | null; results: IndirectExposureResult[] }> {
  const industry = COMMODITY_TW_INDUSTRY[commodity] ?? null;
  if (!industry) return { industry: null, results: [] };

  const etfRows = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; name: string; weight: string; as_of: string }>>(
    `WITH latest AS (SELECT etf_id, max(as_of_date) AS d FROM holdings WHERE asset_type='ETF' GROUP BY etf_id)
     SELECT e.id::text, e.code, e.name, sum(h.weight)::text AS weight, l.d::text AS as_of
       FROM holdings h
       JOIN latest l ON l.etf_id = h.etf_id AND l.d = h.as_of_date
       JOIN etfs e ON e.id = h.etf_id
       JOIN stocks s ON s.ticker = h.ticker AND s.country = 'TW'
      WHERE h.asset_type = 'ETF' AND s.industry = $1
      GROUP BY e.id, e.code, e.name, l.d
     HAVING sum(h.weight) > $2
      ORDER BY sum(h.weight) DESC
      LIMIT 10`,
    industry,
    MIN_SECTOR_WEIGHT_PCT,
  );
  const fundRows = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; name: string; weight: string; as_of: string }>>(
    `WITH latest AS (SELECT fund_id, max(as_of_date) AS d FROM holdings WHERE asset_type='FUND' GROUP BY fund_id)
     SELECT f.id::text, f.code, f.name, sum(h.weight)::text AS weight, l.d::text AS as_of
       FROM holdings h
       JOIN latest l ON l.fund_id = h.fund_id AND l.d = h.as_of_date
       JOIN funds f ON f.id = h.fund_id
       JOIN stocks s ON s.ticker = h.ticker AND s.country = 'TW'
      WHERE h.asset_type = 'FUND' AND s.industry = $1
      GROUP BY f.id, f.code, f.name, l.d
     HAVING sum(h.weight) > $2
      ORDER BY sum(h.weight) DESC
      LIMIT 10`,
    industry,
    MIN_SECTOR_WEIGHT_PCT,
  );

  const results: IndirectExposureResult[] = [
    ...etfRows.map((r) => ({ assetType: "ETF" as const, code: r.code, name: r.name, id: r.id, sectorWeightPct: Number(r.weight), asOfDate: r.as_of })),
    ...fundRows.map((r) => ({ assetType: "FUND" as const, code: r.code, name: r.name, id: r.id, sectorWeightPct: Number(r.weight), asOfDate: r.as_of })),
  ].sort((a, b) => b.sectorWeightPct - a.sectorWeightPct);

  return { industry, results };
}
