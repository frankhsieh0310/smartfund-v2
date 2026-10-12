// Same no-DDL / SELECT-before-INSERT dedup convention as lib/offshore-dividend-sync/writer.ts. The
// currency gate (row dropped unless SITCA's 配息幣別 matches funds.currency) is applied by the caller
// before candidates ever reach this module -- see route.ts.
//
// Batched (one multi-row INSERT per chunk via jsonb_to_recordset), not per-row: same fix applied to
// lib/offshore-dividend-sync/writer.ts after the 2026-10-12 timeout incident (per-row round-trips at
// ~1.1s each made a few-hundred-row batch alone eat most of the 300s budget; this pipeline can have
// an order of magnitude more candidates during the historical backfill, so the same bug here would be
// far worse).
import type { DividendMatchResult } from "./types";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export const SOURCE = "SITCA_FSC_OFFICIAL_MONTHLY";
export const WRITE_CHUNK_SIZE = 500;

export async function writeDividendBatch(query: QueryFn, candidates: DividendMatchResult[]): Promise<{ written: number; skippedExisting: number; writeErrorCount: number }> {
  if (candidates.length === 0) return { written: 0, skippedExisting: 0, writeErrorCount: 0 };

  const fundIds = [...new Set(candidates.map((c) => c.fundId))];
  const existingRows = await query(
    `SELECT fund_id, ex_date::text AS ex_date FROM fund_distribution_observations WHERE fund_id = ANY($1::text[]) AND source = $2`,
    [fundIds, SOURCE],
  );
  const existingKeys = new Set(existingRows.map((r) => `${r.fund_id}::${r.ex_date}`));

  const toInsert = candidates.filter((c) => !existingKeys.has(`${c.fundId}::${c.row.exDate}`));
  const skippedExisting = candidates.length - toInsert.length;

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
      const rows = await query(
        `INSERT INTO fund_distribution_observations
           (id, fund_id, ex_date, record_date, pay_date, distribution_amount, distribution_currency,
            distribution_type, source, source_record_id, created_at, updated_at)
         SELECT gen_random_uuid()::text, x.fund_id, x.ex_date::date, x.record_date::date, x.pay_date::date,
                x.distribution_amount::numeric, x.distribution_currency, 'REGULAR', $2, x.source_record_id, NOW(), NOW()
         FROM jsonb_to_recordset($1::jsonb) AS x(
           fund_id text, ex_date text, record_date text, pay_date text, distribution_amount numeric,
           distribution_currency text, source_record_id text
         )
         RETURNING id`,
        [JSON.stringify(payload), SOURCE],
      );
      written += rows.length;
    } catch {
      writeErrorCount += chunk.length;
    }
  }
  return { written, skippedExisting, writeErrorCount };
}

export async function writeBatchIfEnabled(query: QueryFn, candidates: DividendMatchResult[], writeEnabled: boolean) {
  if (!writeEnabled) return { written: 0, skippedExisting: 0, writeErrorCount: 0 };
  return writeDividendBatch(query, candidates);
}
