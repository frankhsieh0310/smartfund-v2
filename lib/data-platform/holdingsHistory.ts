// Per-product historical holdings (table / concentration / diff) for the mobile app's
// /api/holdings/[type]/[id]/{table,concentration,diff} routes. Reuses the SAME `holdings` table and
// the SAME "prefer ETF_OFFICIAL_DAILY_SNAPSHOT when present" dedup guard already proven correct in
// /api/mobile/current-holdings — no second holdings pipeline, no mock/fabricated snapshots.
import { prisma } from "@/lib/prisma";

export type ProductType = "ETF" | "FUND";
export type CoverageDepth = "TOP_N" | "PARTIAL" | "FULL" | "UNKNOWN";

export type HoldingRow = {
  key: string;
  name: string;
  ticker: string | null;
  weightPct: number;
  sector: string | null;
  country: string | null;
};

// One snapshot's full row set for a product, honestly reporting which source produced it. `source`
// drives the coverage-depth call: ETF_OFFICIAL_DAILY_SNAPSHOT is the one source this codebase already
// treats as a verified-complete daily snapshot (Function 2); everything else is reported as UNKNOWN
// coverage rather than guessed, since the `holdings` table alone carries no completeness signal.
async function fetchSnapshot(productType: ProductType, productId: string, asOfDate: string): Promise<{ rows: HoldingRow[]; source: string | null }> {
  const col = productType === "ETF" ? "etf_id" : "fund_id";
  const rows = await prisma.$queryRawUnsafe<Array<{
    key: string; name: string; ticker: string | null; weight: string | null; sector: string | null; country: string | null; source: string;
  }>>(
    `WITH etf_official AS (SELECT DISTINCT etf_id FROM holdings WHERE etf_id IS NOT NULL AND source='ETF_OFFICIAL_DAILY_SNAPSHOT')
     SELECT coalesce(h.security_id, h.ticker, h.holding_code, h.holding_name) key, h.holding_name name,
            h.ticker, h.weight::text weight, h.sector, h.country, h.source
       FROM holdings h
      WHERE h.${col} = $1 AND h.as_of_date = $2::date
        AND (h.etf_id IS NULL OR NOT EXISTS(SELECT 1 FROM etf_official eo WHERE eo.etf_id = h.etf_id) OR h.source = 'ETF_OFFICIAL_DAILY_SNAPSHOT')
      ORDER BY h.weight DESC NULLS LAST, h.rank NULLS LAST`,
    productId, asOfDate,
  );
  return {
    rows: rows.map((r) => ({ key: r.key, name: r.name, ticker: r.ticker, weightPct: r.weight == null ? 0 : Number(r.weight), sector: r.sector, country: r.country })),
    source: rows[0]?.source ?? null,
  };
}

export function coverageDepthOf(source: string | null): CoverageDepth {
  if (source === "ETF_OFFICIAL_DAILY_SNAPSHOT") return "FULL";
  if (!source) return "UNKNOWN";
  return "UNKNOWN";
}

// Up to `limit` most recent DISTINCT as_of_date values this product actually has rows for — real
// dates only, never synthesized. Applies the same official-source preference as fetchSnapshot so the
// date list matches what fetchSnapshot would actually return rows for at each date.
export async function listSnapshotDates(productType: ProductType, productId: string, limit = 2): Promise<string[]> {
  const col = productType === "ETF" ? "etf_id" : "fund_id";
  // `limit` is always an internal constant (1 or 2), never user input, so inlining it is safe — same
  // pattern already used elsewhere in this codebase for internal-only bounds. Kept as a plain number
  // (not a $N parameter) because this specific query shape intermittently triggered a raw-query
  // parameter-decoding failure ("e.map is not a function") under this machine's local dev Prisma
  // engine when a second numeric parameter followed the WHERE clause's own bound parameter.
  const safeLimit = Math.max(1, Math.min(10, Math.trunc(limit)));
  const rows = await prisma.$queryRawUnsafe<Array<{ d: string }>>(
    `WITH etf_official AS (SELECT DISTINCT etf_id FROM holdings WHERE etf_id IS NOT NULL AND source='ETF_OFFICIAL_DAILY_SNAPSHOT')
     SELECT DISTINCT h.as_of_date::text d FROM holdings h
      WHERE h.${col} = $1
        AND (h.etf_id IS NULL OR NOT EXISTS(SELECT 1 FROM etf_official eo WHERE eo.etf_id = h.etf_id) OR h.source = 'ETF_OFFICIAL_DAILY_SNAPSHOT')
      ORDER BY d DESC LIMIT ${safeLimit}`,
    productId,
  );
  return rows.map((r) => r.d);
}

export async function getLatestSnapshot(productType: ProductType, productId: string): Promise<{ asOfDate: string; rows: HoldingRow[]; source: string | null } | null> {
  const dates = await listSnapshotDates(productType, productId, 1);
  if (!dates.length) return null;
  const { rows, source } = await fetchSnapshot(productType, productId, dates[0]);
  return { asOfDate: dates[0], rows, source };
}

export async function getTwoLatestSnapshots(productType: ProductType, productId: string): Promise<{
  latest: string; previous: string | null; latestRows: HoldingRow[]; previousRows: HoldingRow[];
  latestSource: string | null; previousSource: string | null;
}> {
  const dates = await listSnapshotDates(productType, productId, 2);
  if (!dates.length) return { latest: "", previous: null, latestRows: [], previousRows: [], latestSource: null, previousSource: null };
  const latestSnap = await fetchSnapshot(productType, productId, dates[0]);
  const previousSnap = dates[1] ? await fetchSnapshot(productType, productId, dates[1]) : { rows: [], source: null };
  return { latest: dates[0], previous: dates[1] ?? null, latestRows: latestSnap.rows, previousRows: previousSnap.rows, latestSource: latestSnap.source, previousSource: previousSnap.source };
}
