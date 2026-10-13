// Same no-DDL / SELECT-before-INSERT dedup convention as lib/offshore-dividend-sync/writer.ts. The
// currency gate (row dropped unless SITCA's 配息幣別 matches funds.currency) is applied by the caller
// before candidates ever reach this module -- see route.ts.
//
// Batched (one multi-row INSERT per chunk via jsonb_to_recordset), not per-row: same fix applied to
// lib/offshore-dividend-sync/writer.ts after the 2026-10-12 timeout incident (per-row round-trips at
// ~1.1s each made a few-hundred-row batch alone eat most of the 300s budget; this pipeline can have
// an order of magnitude more candidates during the historical backfill, so the same bug here would be
// far worse).
//
// 2026-10-13 fix: two SITCA data quirks found live force a within-batch dedup pass BEFORE the
// existing-in-DB check below (see lib/dividend-sync-shared/batchDedup.ts for the full root-cause
// writeup). Same-key/same-amount collisions (SITCA republish, payDate off by a day) collapse to one
// row; same-key/different-amount collisions (e.g. 88315292B/D 2024-03, two real independent events
// that happen to share an exDate) are excluded from the write and reported as conflicts instead of
// guessed at. The INSERT also now carries an ON CONFLICT clause targeting the Stage-2 partial unique
// index on (fund_id, ex_date, source) WHERE source IN (...) -- until that index exists, Postgres throws
// 42P10 and the chunk is retried once without ON CONFLICT so writes keep working unchanged.
import type { DividendMatchResult } from "./types";
import { dedupBatchByFundExDate, isMissingUniqueConstraintError, type DedupConflict } from "../dividend-sync-shared/batchDedup.ts";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export const SOURCE = "SITCA_FSC_OFFICIAL_MONTHLY";
export const WRITE_CHUNK_SIZE = 500;

export type WriteDividendBatchResult = {
  written: number;
  skippedExisting: number;
  writeErrorCount: number;
  duplicatesCollapsed: number;
  conflicts: DedupConflict[];
};

const INSERT_COLUMNS_SELECT = `gen_random_uuid()::text, x.fund_id, x.ex_date::date, x.record_date::date, x.pay_date::date,
                x.distribution_amount::numeric, x.distribution_currency, 'REGULAR', $2, x.source_record_id, NOW(), NOW()`;
const INSERT_SOURCE_TABLE = `FROM jsonb_to_recordset($1::jsonb) AS x(
           fund_id text, ex_date text, record_date text, pay_date text, distribution_amount numeric,
           distribution_currency text, source_record_id text
         )`;

function insertSql(withOnConflict: boolean): string {
  return `INSERT INTO fund_distribution_observations
           (id, fund_id, ex_date, record_date, pay_date, distribution_amount, distribution_currency,
            distribution_type, source, source_record_id, created_at, updated_at)
         SELECT ${INSERT_COLUMNS_SELECT}
         ${INSERT_SOURCE_TABLE}
         ${withOnConflict ? `ON CONFLICT (fund_id, ex_date, source) WHERE source = '${SOURCE}' DO NOTHING` : ""}
         RETURNING id`;
}

export async function writeDividendBatch(query: QueryFn, candidates: DividendMatchResult[]): Promise<WriteDividendBatchResult> {
  if (candidates.length === 0) return { written: 0, skippedExisting: 0, writeErrorCount: 0, duplicatesCollapsed: 0, conflicts: [] };

  const deduped = dedupBatchByFundExDate(candidates, (c) => ({ fundId: c.fundId, exDate: c.row.exDate, amount: c.row.amount }));

  const fundIds = [...new Set(deduped.toWrite.map((c) => c.fundId))];
  const existingRows = fundIds.length
    ? await query(
        `SELECT fund_id, ex_date::text AS ex_date FROM fund_distribution_observations WHERE fund_id = ANY($1::text[]) AND source = $2`,
        [fundIds, SOURCE],
      )
    : [];
  const existingKeys = new Set(existingRows.map((r) => `${r.fund_id}::${r.ex_date}`));

  const toInsert = deduped.toWrite.filter((c) => !existingKeys.has(`${c.fundId}::${c.row.exDate}`));
  const skippedExisting = candidates.length - toInsert.length - deduped.duplicatesCollapsed - deduped.conflicts.reduce((n, c) => n + c.count, 0);

  let written = 0;
  let writeErrorCount = 0;
  for (let i = 0; i < toInsert.length; i += WRITE_CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + WRITE_CHUNK_SIZE);
    const payload = chunk.map((c) => ({
      fund_id: c.fundId,
      ex_date: c.row.exDate,
      record_date: c.row.baseDate,
      pay_date: c.row.payDate,
      distribution_amount: c.row.amount,
      distribution_currency: c.sitcaCurrency,
      source_record_id: `${c.fundId}:${c.row.exDate}`,
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

export async function writeBatchIfEnabled(query: QueryFn, candidates: DividendMatchResult[], writeEnabled: boolean): Promise<WriteDividendBatchResult> {
  if (!writeEnabled) return { written: 0, skippedExisting: 0, writeErrorCount: 0, duplicatesCollapsed: 0, conflicts: [] };
  return writeDividendBatch(query, candidates);
}
