// Task P: the ONLY place in this feature that writes to etf_history/etfs — never called at all
// unless lib/market-close-sync/writeGate.ts's isWriteEnabled() is true. Every function here takes a
// QueryFn (same abstraction lib/yahoo/etfHistory.ts already uses) so unit tests inject a mock that
// records calls without ever touching a real database.
//
// Task W7: this module no longer touches etf_performances at all. Live Production hit a numeric
// field overflow ("A field with precision 8, scale 4 must round to an absolute value less than
// 10^4") computing a return percentage against a near-zero base close — a data problem in
// performanceCalc's own math, not a write-path bug, and the task's own decision is to stop computing
// returns here entirely; they'll be sourced from Yahoo's own numbers in a separate task instead. The
// old recomputeEtfPerformanceBatch/lookupCloseOnOrBeforeBatch functions (and the performanceCalc
// import) are removed rather than left dead, since nothing here ever calls them again.

import type { ShadowClassification } from "./types.ts";

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
     SELECT gen_random_uuid()::text, x.etf_id, x.date::date, x.close, x.close, x.source, $2::timestamptz
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
 * function never needs to pre-filter by date itself, the SQL guard is unconditional and per-row.
 *
 * Task W6: THE actual, deterministic root cause of every Production crash this and the surrounding
 * tasks chased ("operator does not exist: text = uuid") — `etfs.id` is a plain `text` column
 * (VERIFIED: 16,834/16,834 rows, no uuid column anywhere in this schema), but the WHERE clause below
 * used to compare it against `x.etf_id::uuid`, an explicit cast to a REAL uuid value. Postgres allows
 * uuid -> text as an ASSIGNMENT cast (which is why the INSERT statements elsewhere in this file, with
 * the same `x.etf_id::uuid` pattern, never failed — they're inserting into a text column, not
 * comparing), but there is no equality OPERATOR for text = uuid in a WHERE/comparison context. This
 * function is only ever reached once write mode is on AND a batch actually has a writable
 * (NEW/CHANGED/DB_DISCONTINUITY) row — exactly why shadow-mode runs, and write-mode runs whose batch
 * happened to be all SOURCE_MISSING/NO_BAR/etc, never hit it, while the one invocation that finally
 * had both write-mode-on and a real writable row crashed deterministically, every time. Reproduced
 * live (BEGIN...ROLLBACK, no trace left) before this fix and confirmed gone after removing the
 * erroneous cast — `x.etf_id` is already `text` per its own jsonb_to_recordset column declaration, so
 * no cast at all is needed or correct here. */
export async function updateEtfsLatestForward(query: QueryFn, rows: WritablePrice[], nowIso: string): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({ etf_id: r.etfId, close: r.price, target_date: r.targetLocalDate }));
  const result = await query(
    `UPDATE etfs SET latest_price = x.close, price_updated_at = $2::timestamptz, updated_at = $2::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS x(etf_id text, close numeric, target_date text)
      WHERE etfs.id = x.etf_id
        AND (etfs.price_updated_at IS NULL OR x.target_date::date > etfs.price_updated_at::date)
      RETURNING etfs.id`,
    [JSON.stringify(payload), nowIso],
  );
  return result.length;
}

export type WriteBatchResult = {
  historyWritten: number;
  etfsUpdated: number;
  // Task W7: error isolation — a batch whose write throws (e.g. a future data anomaly neither of us
  // has seen yet) is recorded here rather than propagated. route.ts never aborts the invocation for
  // it: the affected etfIds simply stay missing from etf_history for this target date, and the
  // existing DB-truth gap check (Task W4/W6 — computeDbGapIds, re-verified against the real DB every
  // invocation, never trusting checkpoint alone) will pick them right back up and retry them on a
  // later invocation, with no special-case "retry" bookkeeping needed here at all.
  writeErrorCount: number;
  writeErrorEtfIds: string[];
};

/** The single entry point route.ts calls per batch — every other function in this file is only ever
 * reached through here. `writeEnabled` is passed in explicitly (the caller reads
 * writeGate.isWriteEnabled() once per invocation) rather than read from process.env again in here,
 * so tests can exercise both branches directly without mutating global env state per call. When
 * disabled, or when nothing in the batch is writable, every underlying write function call count is
 * exactly zero — there is no code path that reaches query() at all in either case.
 *
 * Task W7: catches any error from the two writes and reports it as writeErrorCount/writeErrorEtfIds
 * instead of throwing — one bad batch (e.g. the numeric-overflow class of surprise this task was
 * written in response to, though that specific case no longer reaches this file at all since
 * etf_performances writes were removed entirely) must never kill the whole invocation and strand
 * every market scheduled after it. */
export async function writeBatchIfEnabled(
  query: QueryFn,
  candidates: WritablePrice[],
  nowIso: string,
  writeEnabled: boolean,
): Promise<WriteBatchResult> {
  if (!writeEnabled) return { historyWritten: 0, etfsUpdated: 0, writeErrorCount: 0, writeErrorEtfIds: [] };
  const writable = filterWritable(candidates);
  if (writable.length === 0) return { historyWritten: 0, etfsUpdated: 0, writeErrorCount: 0, writeErrorEtfIds: [] };

  try {
    const historyWritten = await writeEtfHistoryBatch(query, writable, nowIso);
    const etfsUpdated = await updateEtfsLatestForward(query, writable, nowIso);
    return { historyWritten, etfsUpdated, writeErrorCount: 0, writeErrorEtfIds: [] };
  } catch {
    return { historyWritten: 0, etfsUpdated: 0, writeErrorCount: writable.length, writeErrorEtfIds: writable.map((w) => w.etfId) };
  }
}
