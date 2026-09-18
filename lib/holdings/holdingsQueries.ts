// Read-only query layer feeding lib/holdings/holdingsAnalysis.ts. No writes, no UI, no API route —
// callers (a future route/script) compose these with the pure functions in holdingsAnalysis.ts.

import type { PrismaClient } from "@prisma/client";
import { classifyHoldingsCoverage, type HoldingsCoverage } from "./coverageDepth";
import type { HoldingRowWithMeta } from "./concentration";
import { diffHoldingsSnapshots, type HoldingRow, type HoldingsDiffEntry, type ProductHoldings } from "./holdingsAnalysis";

const query = (prisma: PrismaClient, sql: string, params: unknown[] = []) =>
  prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;

export type HoldingsTableRow = HoldingRowWithMeta & { ticker: string | null };

export type HoldingsTableView = {
  productId: string;
  asOfDate: string | null;
  source: string | null;
  coverage: HoldingsCoverage;
  rows: HoldingsTableRow[];
};

/** Every distinct effective_date this ETF has a recorded snapshot for, newest first. */
export async function listEtfSnapshotDates(prisma: PrismaClient, etfId: string): Promise<string[]> {
  const rows = await query(
    prisma,
    `SELECT DISTINCT effective_date::text AS d FROM etf_holding_snapshots
      WHERE etf_id = $1 AND effective_date IS NOT NULL
      ORDER BY d DESC`,
    [etfId],
  );
  return rows.map((r) => r.d);
}

/** One ETF's holdings as of a specific snapshot date (or its latest snapshot if omitted). */
export async function getEtfHoldingsAsOf(
  prisma: PrismaClient,
  etfId: string,
  effectiveDate?: string,
): Promise<ProductHoldings & { coverage: HoldingsCoverage }> {
  const snapshotRows = await query(
    prisma,
    `SELECT id, effective_date::text AS effective_date, source, canonical_row_count
       FROM etf_holding_snapshots
      WHERE etf_id = $1 AND ($2::date IS NULL OR effective_date = $2::date)
      ORDER BY effective_date DESC LIMIT 1`,
    [etfId, effectiveDate ?? null],
  );
  const snapshot = snapshotRows[0];
  if (!snapshot) {
    return { productId: etfId, asOfDate: null, holdings: [], coverage: classifyHoldingsCoverage({ source: null, holdingCount: null }) };
  }
  const rows = await query(
    prisma,
    `SELECT COALESCE(security_id, ticker, holding_name) AS key, holding_name AS name, weight::float AS weight
       FROM etf_holdings WHERE snapshot_id = $1::uuid AND weight IS NOT NULL`,
    [snapshot.id],
  );
  const holdings: HoldingRow[] = rows.map((r) => ({ key: r.key, name: r.name, weightPct: Number(r.weight) }));
  const coverage = classifyHoldingsCoverage({ source: snapshot.source, holdingCount: snapshot.canonical_row_count ?? holdings.length });
  return { productId: etfId, asOfDate: snapshot.effective_date, holdings, coverage };
}

/** Every distinct as_of_date this fund has recorded holdings for, newest first. */
export async function listFundHoldingDates(prisma: PrismaClient, fundId: string): Promise<string[]> {
  const rows = await query(
    prisma,
    `SELECT DISTINCT as_of_date::text AS d FROM holdings
      WHERE fund_id = $1 AND asset_type = 'FUND' AND as_of_date IS NOT NULL
      ORDER BY d DESC`,
    [fundId],
  );
  return rows.map((r) => r.d);
}

/** One fund's holdings as of a specific date (or its latest as_of_date if omitted). */
export async function getFundHoldingsAsOf(
  prisma: PrismaClient,
  fundId: string,
  asOfDate?: string,
): Promise<ProductHoldings & { coverage: HoldingsCoverage }> {
  const targetDateRows = await query(
    prisma,
    `SELECT MAX(as_of_date)::text AS d FROM holdings WHERE fund_id = $1 AND asset_type = 'FUND' AND ($2::date IS NULL OR as_of_date = $2::date)`,
    [fundId, asOfDate ?? null],
  );
  const targetDate = targetDateRows[0]?.d ?? null;
  if (!targetDate) {
    return { productId: fundId, asOfDate: null, holdings: [], coverage: classifyHoldingsCoverage({ source: null, holdingCount: null }) };
  }
  const rows = await query(
    prisma,
    `SELECT COALESCE(security_id, holding_code, holding_name) AS key, holding_name AS name, weight::float AS weight, source
       FROM holdings WHERE fund_id = $1 AND asset_type = 'FUND' AND as_of_date = $2::date AND weight IS NOT NULL`,
    [fundId, targetDate],
  );
  const holdings: HoldingRow[] = rows.map((r) => ({ key: r.key, name: r.name, weightPct: Number(r.weight) }));
  const coverage = classifyHoldingsCoverage({ source: rows[0]?.source ?? null, holdingCount: holdings.length });
  return { productId: fundId, asOfDate: targetDate, holdings, coverage };
}

// ---- Table/concentration view: same underlying data as above, with the ticker/sector/country
// fields the holdings table and concentration breakdown need. Kept as separate functions rather than
// widening the existing ones above, so nothing already depending on their leaner return shape breaks.

/** One ETF's holdings as of a specific (or latest) date, with ticker/sector/country + coverage. */
export async function getEtfHoldingsTableAsOf(
  prisma: PrismaClient,
  etfId: string,
  effectiveDate?: string,
): Promise<HoldingsTableView> {
  const snapshotRows = await query(
    prisma,
    `SELECT id, effective_date::text AS effective_date, source, canonical_row_count
       FROM etf_holding_snapshots
      WHERE etf_id = $1 AND ($2::date IS NULL OR effective_date = $2::date)
      ORDER BY effective_date DESC LIMIT 1`,
    [etfId, effectiveDate ?? null],
  );
  const snapshot = snapshotRows[0];
  if (!snapshot) {
    return { productId: etfId, asOfDate: null, source: null, coverage: classifyHoldingsCoverage({ source: null, holdingCount: null }), rows: [] };
  }
  const rows = (await query(
    prisma,
    `SELECT COALESCE(security_id, ticker, holding_name) AS key, holding_name AS name, ticker,
            weight::float AS weight, sector, country
       FROM etf_holdings WHERE snapshot_id = $1::uuid AND weight IS NOT NULL
       ORDER BY weight DESC`,
    [snapshot.id],
  )) as Array<{ key: string; name: string; ticker: string | null; weight: number; sector: string | null; country: string | null }>;
  const tableRows: HoldingsTableRow[] = rows.map((r) => ({ key: r.key, name: r.name, ticker: r.ticker, weightPct: Number(r.weight), sector: r.sector, country: r.country }));
  const coverage = classifyHoldingsCoverage({ source: snapshot.source, holdingCount: snapshot.canonical_row_count ?? tableRows.length });
  return { productId: etfId, asOfDate: snapshot.effective_date, source: snapshot.source, coverage, rows: tableRows };
}

/** One fund's holdings as of a specific (or latest) date, with ticker/sector/country + coverage. */
export async function getFundHoldingsTableAsOf(
  prisma: PrismaClient,
  fundId: string,
  asOfDate?: string,
): Promise<HoldingsTableView> {
  const targetDateRows = await query(
    prisma,
    `SELECT MAX(as_of_date)::text AS d FROM holdings WHERE fund_id = $1 AND asset_type = 'FUND' AND ($2::date IS NULL OR as_of_date = $2::date)`,
    [fundId, asOfDate ?? null],
  );
  const targetDate = targetDateRows[0]?.d ?? null;
  if (!targetDate) {
    return { productId: fundId, asOfDate: null, source: null, coverage: classifyHoldingsCoverage({ source: null, holdingCount: null }), rows: [] };
  }
  const rows = (await query(
    prisma,
    `SELECT COALESCE(security_id, holding_code, holding_name) AS key, holding_name AS name, ticker,
            weight::float AS weight, sector, country, source
       FROM holdings WHERE fund_id = $1 AND asset_type = 'FUND' AND as_of_date = $2::date AND weight IS NOT NULL
       ORDER BY weight DESC`,
    [fundId, targetDate],
  )) as Array<{ key: string; name: string; ticker: string | null; weight: number; sector: string | null; country: string | null; source: string | null }>;
  const tableRows: HoldingsTableRow[] = rows.map((r) => ({ key: r.key, name: r.name, ticker: r.ticker, weightPct: Number(r.weight), sector: r.sector, country: r.country }));
  const coverage = classifyHoldingsCoverage({ source: rows[0]?.source ?? null, holdingCount: tableRows.length });
  return { productId: fundId, asOfDate: targetDate, source: rows[0]?.source ?? null, coverage, rows: tableRows };
}

// ---- Historical diff: latest snapshot vs the one immediately before it ----

export type HoldingsDiffView = {
  productId: string;
  previousDate: string | null;
  latestDate: string | null;
  hasEnoughHistory: boolean; // false when fewer than 2 dated snapshots exist yet
  entries: HoldingsDiffEntry[];
};

/**
 * Compares an ETF's latest recorded snapshot to the one immediately preceding it. Always uses each
 * snapshot's own source-effective_date (never a fetch/ingestion timestamp) as the date label, since
 * effective_date is exactly what etf_holding_snapshots stores that as.
 */
export async function getEtfHoldingsDiffLatestVsPrevious(prisma: PrismaClient, etfId: string): Promise<HoldingsDiffView> {
  const dates = await listEtfSnapshotDates(prisma, etfId);
  if (dates.length < 2) {
    return { productId: etfId, previousDate: dates[0] ?? null, latestDate: dates[0] ?? null, hasEnoughHistory: false, entries: [] };
  }
  const [latestDate, previousDate] = dates;
  const [latest, previous] = await Promise.all([
    getEtfHoldingsAsOf(prisma, etfId, latestDate),
    getEtfHoldingsAsOf(prisma, etfId, previousDate),
  ]);
  return {
    productId: etfId,
    previousDate: previous.asOfDate,
    latestDate: latest.asOfDate,
    hasEnoughHistory: true,
    entries: diffHoldingsSnapshots(previous.holdings, latest.holdings),
  };
}

/** Same comparison for a fund, using each holdings row's own as_of_date (source-effective). */
export async function getFundHoldingsDiffLatestVsPrevious(prisma: PrismaClient, fundId: string): Promise<HoldingsDiffView> {
  const dates = await listFundHoldingDates(prisma, fundId);
  if (dates.length < 2) {
    return { productId: fundId, previousDate: dates[0] ?? null, latestDate: dates[0] ?? null, hasEnoughHistory: false, entries: [] };
  }
  const [latestDate, previousDate] = dates;
  const [latest, previous] = await Promise.all([
    getFundHoldingsAsOf(prisma, fundId, latestDate),
    getFundHoldingsAsOf(prisma, fundId, previousDate),
  ]);
  return {
    productId: fundId,
    previousDate: previous.asOfDate,
    latestDate: latest.asOfDate,
    hasEnoughHistory: true,
    entries: diffHoldingsSnapshots(previous.holdings, latest.holdings),
  };
}
