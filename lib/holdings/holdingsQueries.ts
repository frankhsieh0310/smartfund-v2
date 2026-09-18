// Read-only query layer feeding lib/holdings/holdingsAnalysis.ts. No writes, no UI, no API route —
// callers (a future route/script) compose these with the pure functions in holdingsAnalysis.ts.

import type { PrismaClient } from "@prisma/client";
import { classifyHoldingsCoverage, type HoldingsCoverage } from "./coverageDepth";
import type { HoldingRow, ProductHoldings } from "./holdingsAnalysis";

const query = (prisma: PrismaClient, sql: string, params: unknown[] = []) =>
  prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;

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
       FROM etf_holding_rows WHERE snapshot_id = $1 AND weight IS NOT NULL`,
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
