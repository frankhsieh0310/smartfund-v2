// fund_distribution_observations has no unique constraint beyond its primary key (confirmed via
// information_schema before building this), so "same distribution never written twice" is enforced in
// application code: SELECT existing (fund_id, ex_date) rows for the whole candidate batch up front,
// then only INSERT rows that are genuinely new. No DDL needed -- every column this pipeline writes
// (ex_date, record_date, pay_date, distribution_amount, distribution_currency, income_component,
// return_of_capital, source) already exists on the table.
//
// Batched, not per-row: the original per-row INSERT loop (one round-trip per row, ~1.1s observed per
// row against this connection) was what caused the 2026-10-12 12:08 UTC run to blow through Vercel's
// 300s maxDuration after only 51/~330 candidates -- confirmed live via `vercel logs` showing
// "Task timed out after 300 seconds", the run-log row stuck IN_PROGRESS, and exactly 51 rows actually
// persisted. Each chunk is now a single multi-row INSERT via jsonb_to_recordset, so a chunk of up to
// CHUNK rows costs one round-trip instead of CHUNK of them. Error isolation is per-CHUNK (one bad
// chunk's exception doesn't block the next), not per-row -- a reasonable trade for a pipeline where
// row-level failure is rare (the gate on required columns already happened in fetchClear.ts).
//
// 2026-10-13 fix: same within-batch dedup pass added to the domestic-dividend-sync writer, for the same
// reason -- see lib/dividend-sync-shared/batchDedup.ts for the root-cause writeup (confirmed scoped to
// SITCA_FSC_OFFICIAL_MONTHLY only; this source had zero same-batch or DB-existing duplicates as of the
// 2026-10-13 investigation, but the dedup/conflict/ON-CONFLICT machinery is shared so both writers stay
// consistent and this source is protected if it ever does collide).
import type { FundclearDistributionRecord } from "./types";
import { dedupBatchByFundExDate, isMissingUniqueConstraintError, type DedupConflict } from "../dividend-sync-shared/batchDedup.ts";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type DistributionWriteCandidate = {
  fundId: string;
  currency: string;
  record: FundclearDistributionRecord;
};

export const SOURCE = "FUNDCLEAR_TDCC_OFFSHORE";
export const WRITE_CHUNK_SIZE = 200;

export type WriteDistributionBatchResult = {
  written: number;
  skippedExisting: number;
  writeErrorCount: number;
  duplicatesCollapsed: number;
  conflicts: DedupConflict[];
};

function insertSql(withOnConflict: boolean): string {
  return `INSERT INTO fund_distribution_observations
           (id, fund_id, ex_date, record_date, pay_date, distribution_amount, distribution_currency,
            distribution_type, income_component, return_of_capital, source, source_record_id, created_at, updated_at)
         SELECT gen_random_uuid()::text, x.fund_id, x.ex_date::date, x.record_date::date, x.pay_date::date,
                x.distribution_amount::numeric, x.distribution_currency, 'REGULAR',
                x.income_component::numeric, x.return_of_capital::numeric, $2, x.source_record_id, NOW(), NOW()
         FROM jsonb_to_recordset($1::jsonb) AS x(
           fund_id text, ex_date text, record_date text, pay_date text, distribution_amount numeric,
           distribution_currency text, income_component numeric, return_of_capital numeric, source_record_id text
         )
         ${withOnConflict ? `ON CONFLICT (fund_id, ex_date, source) WHERE source = '${SOURCE}' DO NOTHING` : ""}
         RETURNING id`;
}

export async function writeDistributionBatch(query: QueryFn, candidates: DistributionWriteCandidate[]): Promise<WriteDistributionBatchResult> {
  if (candidates.length === 0) return { written: 0, skippedExisting: 0, writeErrorCount: 0, duplicatesCollapsed: 0, conflicts: [] };

  const deduped = dedupBatchByFundExDate(candidates, (c) => ({ fundId: c.fundId, exDate: c.record.exDate, amount: c.record.amount }));

  const fundIds = [...new Set(deduped.toWrite.map((c) => c.fundId))];
  const existingRows = fundIds.length
    ? await query(
        `SELECT fund_id, ex_date::text AS ex_date FROM fund_distribution_observations WHERE fund_id = ANY($1::text[]) AND source = $2`,
        [fundIds, SOURCE],
      )
    : [];
  const existingKeys = new Set(existingRows.map((r) => `${r.fund_id}::${r.ex_date}`));

  const toInsert = deduped.toWrite.filter((c) => !existingKeys.has(`${c.fundId}::${c.record.exDate}`));
  const skippedExisting = candidates.length - toInsert.length - deduped.duplicatesCollapsed - deduped.conflicts.reduce((n, c) => n + c.count, 0);

  let written = 0;
  let writeErrorCount = 0;
  for (let i = 0; i < toInsert.length; i += WRITE_CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + WRITE_CHUNK_SIZE);
    const payload = chunk.map((c) => ({
      fund_id: c.fundId,
      ex_date: c.record.exDate,
      record_date: c.record.baseDate,
      pay_date: c.record.payDate,
      distribution_amount: c.record.amount,
      distribution_currency: c.currency,
      income_component: c.record.incomeRatioPct,
      return_of_capital: c.record.returnOfCapitalRatioPct,
      source_record_id: `${c.fundId}:${c.record.exDate}`,
    }));
    try {
      let rows: any[];
      try {
        rows = await query(insertSql(true), [JSON.stringify(payload), SOURCE]);
      } catch (e) {
        if (!isMissingUniqueConstraintError(e)) throw e;
        rows = await query(insertSql(false), [JSON.stringify(payload), SOURCE]);
      }
      written += rows.length;
    } catch {
      writeErrorCount += chunk.length;
    }
  }
  return { written, skippedExisting, writeErrorCount, duplicatesCollapsed: deduped.duplicatesCollapsed, conflicts: deduped.conflicts };
}

export async function writeBatchIfEnabled(query: QueryFn, candidates: DistributionWriteCandidate[], writeEnabled: boolean): Promise<WriteDistributionBatchResult> {
  if (!writeEnabled) return { written: 0, skippedExisting: 0, writeErrorCount: 0, duplicatesCollapsed: 0, conflicts: [] };
  return writeDistributionBatch(query, candidates);
}
