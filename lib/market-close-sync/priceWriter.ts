// Task P: the ONLY place in this feature that writes to etf_history/etfs/etf_performances — never
// called at all unless lib/market-close-sync/writeGate.ts's isWriteEnabled() is true. Every function
// here takes a QueryFn (same abstraction lib/yahoo/etfHistory.ts already uses) so unit tests inject
// a mock that records calls without ever touching a real database — this module is never exercised
// against a real DB during this task; only mocked tests and static review.

import type { ShadowClassification } from "./types.ts";
import { PERFORMANCE_PERIODS, PERFORMANCE_PERIOD_DAYS, baseDateFor, computeReturn } from "./performanceCalc.ts";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type WritablePrice = {
  etfId: string;
  symbol: string;
  classification: ShadowClassification;
  targetLocalDate: string; // the market's own local trading day — a plain calendar date, never re-projected through a timezone
  price: number;
  source: "BAR" | "QUOTE_FINAL";
};

// Only these three classifications are ever written. UNIT_MISMATCH and the unresolved
// PRICE_JUMP_REVIEW are excluded unconditionally — this set is the single source of truth for
// "writable", referenced by both the filter below and the task's own test requirement.
const WRITABLE_CLASSIFICATIONS: ReadonlySet<ShadowClassification> = new Set(["NEW", "CHANGED", "DB_DISCONTINUITY"]);

export function isWritableClassification(classification: ShadowClassification): boolean {
  return WRITABLE_CLASSIFICATIONS.has(classification);
}

export function filterWritable(candidates: WritablePrice[]): WritablePrice[] {
  return candidates.filter((c) => isWritableClassification(c.classification));
}

/** Batch INSERT ... ON CONFLICT (etf_id, date) DO UPDATE, one round trip for the whole batch — never
 * one query per row. The WHERE clause on the UPDATE arm means a row whose close hasn't actually
 * changed is a no-op write (no row returned), matching the task's "WHERE 值有變動" requirement. */
export async function writeEtfHistoryBatch(query: QueryFn, rows: WritablePrice[], nowIso: string): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({ etf_id: r.etfId, date: r.targetLocalDate, close: r.price, source: r.source }));
  const result = await query(
    `INSERT INTO etf_history (id, etf_id, date, price, close, source, known_at)
     SELECT gen_random_uuid()::text, x.etf_id::uuid, x.date::date, x.close, x.close, x.source, $2::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS x(etf_id text, date text, close numeric, source text)
     ON CONFLICT (etf_id, date) DO UPDATE SET
       close = EXCLUDED.close, price = EXCLUDED.price, source = EXCLUDED.source, known_at = EXCLUDED.known_at
     WHERE etf_history.close IS DISTINCT FROM EXCLUDED.close
     RETURNING 1`,
    [JSON.stringify(payload), nowIso],
  );
  return result.length;
}

/** Forward-only: etfs.latest_price/price_updated_at are only overwritten when the new row's own
 * target date is strictly newer than whatever calendar date price_updated_at currently reflects (or
 * price_updated_at is still null, e.g. a genuinely new ETF). A batch containing an older target date
 * than what's already stored is simply excluded from the UPDATE by its own WHERE clause — this
 * function never needs to pre-filter by date itself, the SQL guard is unconditional and per-row. */
export async function updateEtfsLatestForward(query: QueryFn, rows: WritablePrice[], nowIso: string): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({ etf_id: r.etfId, close: r.price, target_date: r.targetLocalDate }));
  const result = await query(
    `UPDATE etfs SET latest_price = x.close, price_updated_at = $2::timestamptz, updated_at = $2::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS x(etf_id text, close numeric, target_date text)
      WHERE etfs.id = x.etf_id::uuid
        AND (etfs.price_updated_at IS NULL OR x.target_date::date > etfs.price_updated_at::date)
      RETURNING etfs.id`,
    [JSON.stringify(payload), nowIso],
  );
  return result.length;
}

/** The last close on or before `date` for a batch of ETFs — one query per distinct base date,
 * covering every ETF in the batch at once (DISTINCT ON), never one query per ETF per period. */
async function lookupCloseOnOrBeforeBatch(query: QueryFn, etfIds: string[], date: string): Promise<Map<string, number>> {
  if (etfIds.length === 0) return new Map();
  const rows = await query(
    `SELECT DISTINCT ON (etf_id) etf_id, close FROM etf_history
      WHERE etf_id = ANY($1) AND date <= $2::date AND close IS NOT NULL
      ORDER BY etf_id, date DESC`,
    [etfIds, date],
  );
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.etf_id, Number(r.close));
  return m;
}

/** Recomputes etf_performances ONLY for the ETFs just written this batch (never the whole
 * universe), per the task's "只為本次有寫入的ETF重算". Groups by targetLocalDate (in practice a
 * single invocation only ever has one target date per market) so each of the 6 periods needs just
 * one batched base-close lookup covering every ETF in that date's group, not 6×N per-ETF queries. */
export async function recomputeEtfPerformanceBatch(
  query: QueryFn,
  rows: Array<{ etfId: string; targetLocalDate: string; targetClose: number }>,
  nowIso: string,
): Promise<number> {
  if (rows.length === 0) return 0;

  const byDate = new Map<string, Array<{ etfId: string; targetLocalDate: string; targetClose: number }>>();
  for (const r of rows) {
    const group = byDate.get(r.targetLocalDate);
    if (group) group.push(r);
    else byDate.set(r.targetLocalDate, [r]);
  }

  const perfRows: Array<Record<string, unknown>> = [];
  for (const [date, group] of byDate) {
    const etfIds = group.map((g) => g.etfId);
    const baseClosesByPeriod = new Map<string, Map<string, number>>();
    for (const period of PERFORMANCE_PERIODS) {
      baseClosesByPeriod.set(period, await lookupCloseOnOrBeforeBatch(query, etfIds, baseDateFor(date, PERFORMANCE_PERIOD_DAYS[period])));
    }
    for (const g of group) {
      const entry: Record<string, unknown> = { etf_id: g.etfId, date: g.targetLocalDate, price: g.targetClose };
      for (const period of PERFORMANCE_PERIODS) {
        entry[`r_${period.toLowerCase()}`] = computeReturn(g.targetClose, baseClosesByPeriod.get(period)!.get(g.etfId) ?? null);
      }
      perfRows.push(entry);
    }
  }

  const result = await query(
    `INSERT INTO etf_performances (id, etf_id, date, price, return_1d, return_1m, return_3m, return_6m, return_1y, return_3y, created_at)
     SELECT gen_random_uuid(), x.etf_id::uuid, x.date::date, x.price, x.r_1d, x.r_1m, x.r_3m, x.r_6m, x.r_1y, x.r_3y, $2::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS x(etf_id text, date text, price numeric, r_1d numeric, r_1m numeric, r_3m numeric, r_6m numeric, r_1y numeric, r_3y numeric)
     ON CONFLICT (etf_id, date) DO UPDATE SET
       price = EXCLUDED.price, return_1d = EXCLUDED.return_1d, return_1m = EXCLUDED.return_1m,
       return_3m = EXCLUDED.return_3m, return_6m = EXCLUDED.return_6m, return_1y = EXCLUDED.return_1y, return_3y = EXCLUDED.return_3y
     RETURNING 1`,
    [JSON.stringify(perfRows), nowIso],
  );
  return result.length;
}

export type WriteBatchResult = { historyWritten: number; etfsUpdated: number; performanceRecomputed: number };

/** The single entry point route.ts calls per batch — every other function in this file is only ever
 * reached through here. `writeEnabled` is passed in explicitly (the caller reads
 * writeGate.isWriteEnabled() once per invocation) rather than read from process.env again in here,
 * so tests can exercise both branches directly without mutating global env state per call. When
 * disabled, or when nothing in the batch is writable, every underlying write function call count is
 * exactly zero — there is no code path that reaches query() at all in either case. */
export async function writeBatchIfEnabled(
  query: QueryFn,
  candidates: WritablePrice[],
  nowIso: string,
  writeEnabled: boolean,
): Promise<WriteBatchResult> {
  if (!writeEnabled) return { historyWritten: 0, etfsUpdated: 0, performanceRecomputed: 0 };
  const writable = filterWritable(candidates);
  if (writable.length === 0) return { historyWritten: 0, etfsUpdated: 0, performanceRecomputed: 0 };

  const historyWritten = await writeEtfHistoryBatch(query, writable, nowIso);
  const etfsUpdated = await updateEtfsLatestForward(query, writable, nowIso);
  const performanceRecomputed = await recomputeEtfPerformanceBatch(
    query,
    writable.map((w) => ({ etfId: w.etfId, targetLocalDate: w.targetLocalDate, targetClose: w.price })),
    nowIso,
  );
  return { historyWritten, etfsUpdated, performanceRecomputed };
}
