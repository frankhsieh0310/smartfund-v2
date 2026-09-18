// Read-only query layer feeding lib/holdings/holdingsAnalysis.ts. No writes, no UI — the holdings API
// routes and pages compose these with the pure functions in holdingsAnalysis.ts / diffComparability.ts.

import type { PrismaClient } from "@prisma/client";
import { classifyHoldingsCoverage, type HoldingsCoverage } from "./coverageDepth";
import type { HoldingRowWithMeta } from "./concentration";
import { applyComparability, assessDiffComparability, type DiffComparability, type SnapshotDepth } from "./diffComparability";
import { mergeByCanonicalKey } from "./holdingKey";
import { diffHoldingsSnapshots, type HoldingRow, type HoldingsDiffEntry, type ProductHoldings } from "./holdingsAnalysis";

const query = (prisma: PrismaClient, sql: string, params: unknown[] = []) =>
  prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;

export type HoldingsTableRow = HoldingRowWithMeta & { ticker: string | null };

export type HoldingsTableView = {
  productId: string;
  asOfDate: string | null;
  source: string | null;
  /** count the source declares for the full portfolio (ETF snapshots only), when known */
  declaredCount: number | null;
  /** rows actually stored and returned */
  presentRowCount: number;
  coverage: HoldingsCoverage;
  rows: HoldingsTableRow[];
};

const depthOf = (coverage: HoldingsCoverage, date: string | null, source: string | null, present: number, declared: number | null): SnapshotDepth => ({
  date,
  source,
  coverageDepth: coverage.coverage_depth,
  presentRowCount: present,
  declaredCount: declared,
});

// ---- ETF side ----

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

type EtfSnapshotPick = { id: string; effective_date: string | null; source: string | null; canonical_row_count: number | null; row_count: number };

/**
 * Picks ONE snapshot: dated beats undated (a NULL effective_date snapshot never shadows a dated one),
 * then newest date, then the caller's preferred source (keeps a diff's two sides like-for-like), then
 * the deepest snapshot (most stored rows), then the most recently retrieved.
 */
async function pickEtfSnapshot(prisma: PrismaClient, etfId: string, effectiveDate?: string, preferSource?: string | null): Promise<EtfSnapshotPick | null> {
  const rows = await query(
    prisma,
    `SELECT s.id, s.effective_date::text AS effective_date, s.source, s.canonical_row_count,
            (SELECT count(*)::int FROM etf_holdings h WHERE h.snapshot_id = s.id AND h.weight IS NOT NULL) AS row_count
       FROM etf_holding_snapshots s
      WHERE s.etf_id = $1 AND ($2::date IS NULL OR s.effective_date = $2::date)
      ORDER BY (s.effective_date IS NULL) ASC, s.effective_date DESC,
               ($3::text IS NOT NULL AND s.source = $3::text) DESC,
               row_count DESC, s.retrieved_at DESC NULLS LAST
      LIMIT 1`,
    [etfId, effectiveDate ?? null, preferSource ?? null],
  );
  return rows[0] ?? null;
}

type EtfHoldingsLoad = ProductHoldings & { coverage: HoldingsCoverage; source: string | null; declaredCount: number | null };

async function loadEtfHoldings(prisma: PrismaClient, etfId: string, effectiveDate?: string, preferSource?: string | null): Promise<EtfHoldingsLoad> {
  const snapshot = await pickEtfSnapshot(prisma, etfId, effectiveDate, preferSource);
  if (!snapshot) {
    return { productId: etfId, asOfDate: null, holdings: [], source: null, declaredCount: null, coverage: classifyHoldingsCoverage({ source: null, holdingCount: null }) };
  }
  const rows = await query(
    prisma,
    `SELECT COALESCE(security_id, ticker, holding_name) AS key, holding_name AS name, weight::float AS weight
       FROM etf_holdings WHERE snapshot_id = $1::uuid AND weight IS NOT NULL`,
    [snapshot.id],
  );
  const holdings: HoldingRow[] = mergeByCanonicalKey(rows.map((r) => ({ key: r.key, name: r.name, weightPct: Number(r.weight) })));
  const coverage = classifyHoldingsCoverage({ source: snapshot.source, holdingCount: snapshot.canonical_row_count ?? holdings.length });
  return { productId: etfId, asOfDate: snapshot.effective_date, holdings, source: snapshot.source, declaredCount: snapshot.canonical_row_count, coverage };
}

/** One ETF's holdings as of a specific snapshot date (or its best latest snapshot if omitted). */
export async function getEtfHoldingsAsOf(
  prisma: PrismaClient,
  etfId: string,
  effectiveDate?: string,
): Promise<ProductHoldings & { coverage: HoldingsCoverage }> {
  const { productId, asOfDate, holdings, coverage } = await loadEtfHoldings(prisma, etfId, effectiveDate);
  return { productId, asOfDate, holdings, coverage };
}

/** One ETF's holdings as of a specific (or latest) date, with ticker/sector/country + coverage. */
export async function getEtfHoldingsTableAsOf(
  prisma: PrismaClient,
  etfId: string,
  effectiveDate?: string,
): Promise<HoldingsTableView> {
  const snapshot = await pickEtfSnapshot(prisma, etfId, effectiveDate);
  if (!snapshot) {
    return { productId: etfId, asOfDate: null, source: null, declaredCount: null, presentRowCount: 0, coverage: classifyHoldingsCoverage({ source: null, holdingCount: null }), rows: [] };
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
  return {
    productId: etfId,
    asOfDate: snapshot.effective_date,
    source: snapshot.source,
    declaredCount: snapshot.canonical_row_count,
    presentRowCount: tableRows.length,
    coverage,
    rows: tableRows,
  };
}

// ---- Fund side ----

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

type FundHoldingsLoad = ProductHoldings & { coverage: HoldingsCoverage; source: string | null; tableRows: HoldingsTableRow[] };

/**
 * Rows for one fund at one date, from ONE source only. A date can carry rows from several sources
 * (e.g. an SEC filing plus a top-N vendor list); mixing them would double-count, so we keep the
 * preferred source, else the confirmed-FULL source, else the one with the most rows.
 */
async function loadFundHoldings(prisma: PrismaClient, fundId: string, asOfDate?: string, preferSource?: string | null): Promise<FundHoldingsLoad> {
  const empty: FundHoldingsLoad = {
    productId: fundId,
    asOfDate: null,
    holdings: [],
    tableRows: [],
    source: null,
    coverage: classifyHoldingsCoverage({ source: null, holdingCount: null }),
  };
  const dateRows = await query(
    prisma,
    `SELECT MAX(as_of_date)::text AS d FROM holdings WHERE fund_id = $1 AND asset_type = 'FUND' AND ($2::date IS NULL OR as_of_date = $2::date)`,
    [fundId, asOfDate ?? null],
  );
  const targetDate: string | null = dateRows[0]?.d ?? null;
  if (!targetDate) return empty;
  const sourceRows = await query(
    prisma,
    `SELECT source, count(*)::int AS n FROM holdings
      WHERE fund_id = $1 AND asset_type = 'FUND' AND as_of_date = $2::date AND weight IS NOT NULL
      GROUP BY source
      ORDER BY ($3::text IS NOT NULL AND source = $3::text) DESC, (source LIKE 'SEC_EDGAR_NPORT%') DESC, n DESC
      LIMIT 1`,
    [fundId, targetDate, preferSource ?? null],
  );
  if (!sourceRows.length) return { ...empty, asOfDate: targetDate };
  const source: string | null = sourceRows[0].source ?? null;
  const rows = await query(
    prisma,
    `SELECT COALESCE(security_id, holding_code, holding_name) AS key, holding_name AS name, ticker,
            weight::float AS weight, sector, country
       FROM holdings WHERE fund_id = $1 AND asset_type = 'FUND' AND as_of_date = $2::date AND weight IS NOT NULL
        AND source IS NOT DISTINCT FROM $3::text
      ORDER BY weight DESC`,
    [fundId, targetDate, source],
  );
  const holdings: HoldingRow[] = mergeByCanonicalKey(rows.map((r) => ({ key: r.key, name: r.name, weightPct: Number(r.weight) })));
  const tableRows: HoldingsTableRow[] = rows.map((r) => ({ key: r.key, name: r.name, ticker: r.ticker, weightPct: Number(r.weight), sector: r.sector, country: r.country }));
  const coverage = classifyHoldingsCoverage({ source, holdingCount: holdings.length });
  return { productId: fundId, asOfDate: targetDate, holdings, tableRows, source, coverage };
}

/** One fund's holdings as of a specific date (or its latest as_of_date if omitted). */
export async function getFundHoldingsAsOf(
  prisma: PrismaClient,
  fundId: string,
  asOfDate?: string,
): Promise<ProductHoldings & { coverage: HoldingsCoverage }> {
  const { productId, asOfDate: date, holdings, coverage } = await loadFundHoldings(prisma, fundId, asOfDate);
  return { productId, asOfDate: date, holdings, coverage };
}

/** One fund's holdings as of a specific (or latest) date, with ticker/sector/country + coverage. */
export async function getFundHoldingsTableAsOf(
  prisma: PrismaClient,
  fundId: string,
  asOfDate?: string,
): Promise<HoldingsTableView> {
  const r = await loadFundHoldings(prisma, fundId, asOfDate);
  return { productId: fundId, asOfDate: r.asOfDate, source: r.source, declaredCount: null, presentRowCount: r.tableRows.length, coverage: r.coverage, rows: r.tableRows };
}

// ---- Historical diff: latest snapshot vs the one immediately before it ----

export type HoldingsDiffView = {
  productId: string;
  previousDate: string | null;
  latestDate: string | null;
  hasEnoughHistory: boolean; // false when fewer than 2 dated snapshots exist yet
  /**
   * FULL_VS_FULL: every change. CONSERVATIVE: ADDED/REMOVED are withheld (see newlyDisclosed /
   * noLongerDisclosed) because absence from a truncated list is not proof a position was sold.
   */
  entries: HoldingsDiffEntry[];
  newlyDisclosed: HoldingsDiffEntry[];
  noLongerDisclosed: HoldingsDiffEntry[];
  comparability: DiffComparability | null;
};

const noHistory = (productId: string, date: string | null): HoldingsDiffView => ({
  productId,
  previousDate: date,
  latestDate: date,
  hasEnoughHistory: false,
  entries: [],
  newlyDisclosed: [],
  noLongerDisclosed: [],
  comparability: null,
});

/**
 * Compares an ETF's latest snapshot to the one immediately preceding it (each snapshot's own
 * source-effective date, never a fetch timestamp). The previous side prefers the latest side's source
 * so both periods are like-for-like when possible.
 */
export async function getEtfHoldingsDiffLatestVsPrevious(prisma: PrismaClient, etfId: string): Promise<HoldingsDiffView> {
  const dates = await listEtfSnapshotDates(prisma, etfId);
  if (dates.length < 2) return noHistory(etfId, dates[0] ?? null);
  const [latestDate, previousDate] = dates;
  const latest = await loadEtfHoldings(prisma, etfId, latestDate);
  const previous = await loadEtfHoldings(prisma, etfId, previousDate, latest.source);
  const comparability = assessDiffComparability(
    depthOf(previous.coverage, previous.asOfDate, previous.source, previous.holdings.length, previous.declaredCount),
    depthOf(latest.coverage, latest.asOfDate, latest.source, latest.holdings.length, latest.declaredCount),
  );
  const compared = applyComparability(diffHoldingsSnapshots(previous.holdings, latest.holdings), comparability);
  return { productId: etfId, previousDate: previous.asOfDate, latestDate: latest.asOfDate, hasEnoughHistory: true, ...compared, comparability };
}

/** Same comparison for a fund, using each holdings row's own as_of_date (source-effective). */
export async function getFundHoldingsDiffLatestVsPrevious(prisma: PrismaClient, fundId: string): Promise<HoldingsDiffView> {
  const dates = await listFundHoldingDates(prisma, fundId);
  if (dates.length < 2) return noHistory(fundId, dates[0] ?? null);
  const [latestDate, previousDate] = dates;
  const latest = await loadFundHoldings(prisma, fundId, latestDate);
  const previous = await loadFundHoldings(prisma, fundId, previousDate, latest.source);
  const comparability = assessDiffComparability(
    depthOf(previous.coverage, previous.asOfDate, previous.source, previous.holdings.length, null),
    depthOf(latest.coverage, latest.asOfDate, latest.source, latest.holdings.length, null),
  );
  const compared = applyComparability(diffHoldingsSnapshots(previous.holdings, latest.holdings), comparability);
  return { productId: fundId, previousDate: previous.asOfDate, latestDate: latest.asOfDate, hasEnoughHistory: true, ...compared, comparability };
}
