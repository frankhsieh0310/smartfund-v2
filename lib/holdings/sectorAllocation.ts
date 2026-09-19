// Product-level sector allocation for ETFs, read from the existing etf_sector_allocations table
// (Yahoo quoteSummary, 11 sectors, weights stored as fractions of 1). No schema change and no guessing:
// an ETF with no positive allocation snapshot has NO sector data, and stays "uncovered".

import type { PrismaClient } from "@prisma/client";

export type SectorAllocation = {
  asOfDate: string;
  source: string | null;
  buckets: Array<{ key: string; weightPct: number }>; // percent of the ETF, as published
  coveredPct: number; // sum of buckets (<=100); the remainder of the ETF is not sector-classified by the source
};

export const SECTOR_LABEL_ZH: Record<string, string> = {
  technology: "科技",
  financial_services: "金融服務",
  healthcare: "醫療保健",
  consumer_cyclical: "非必需消費",
  consumer_defensive: "必需消費",
  industrials: "工業",
  communication_services: "通訊服務",
  energy: "能源",
  utilities: "公用事業",
  realestate: "房地產",
  basic_materials: "原物料",
};
export const sectorLabel = (key: string) => SECTOR_LABEL_ZH[key] ?? key;

export type SectorRow = { etf_id: string; observation_date: string; sector_name: string; weight: number; source: string | null };

/** Pure: group raw rows (already restricted to the chosen snapshot per ETF) into allocations. Zero weights are dropped. */
export function groupSectorRows(rows: SectorRow[]): Map<string, SectorAllocation> {
  const out = new Map<string, SectorAllocation>();
  for (const r of rows) {
    const w = Number(r.weight);
    if (!Number.isFinite(w) || w <= 0) continue;
    const cur = out.get(r.etf_id) ?? { asOfDate: r.observation_date, source: r.source, buckets: [], coveredPct: 0 };
    cur.buckets.push({ key: r.sector_name, weightPct: w * 100 });
    cur.coveredPct += w * 100;
    out.set(r.etf_id, cur);
  }
  for (const a of out.values()) a.buckets.sort((x, y) => y.weightPct - x.weightPct);
  return out;
}

/** One query for all ETF ids: the latest observation_date whose weights sum to > 0. */
export async function loadEtfSectorAllocations(prisma: PrismaClient, etfIds: string[]): Promise<Map<string, SectorAllocation>> {
  if (!etfIds.length) return new Map();
  const rows = await prisma.$queryRaw<SectorRow[]>`
    WITH snaps AS (
      SELECT etf_id, observation_date FROM etf_sector_allocations
      WHERE etf_id = ANY(${etfIds}::text[])
      GROUP BY etf_id, observation_date HAVING SUM(weight) > 0
    ), latest AS (
      SELECT DISTINCT ON (etf_id) etf_id, observation_date FROM snaps ORDER BY etf_id, observation_date DESC
    )
    SELECT a.etf_id, a.observation_date::text AS observation_date, a.sector_name, a.weight::float8 AS weight, a.source
    FROM etf_sector_allocations a JOIN latest l ON l.etf_id = a.etf_id AND l.observation_date = a.observation_date`;
  return groupSectorRows(rows);
}
