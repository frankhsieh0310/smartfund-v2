// fund_distribution_observations has no unique constraint beyond its primary key (confirmed via
// information_schema before building this), so "same distribution never written twice" is enforced in
// application code: SELECT existing (fund_id, ex_date) rows for the whole candidate batch up front,
// then only INSERT rows that are genuinely new. No DDL needed -- every column this pipeline writes
// (ex_date, record_date, pay_date, distribution_amount, distribution_currency, income_component,
// return_of_capital, source) already exists on the table.
import type { FundclearDistributionRecord } from "./types";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type DistributionWriteCandidate = {
  fundId: string;
  currency: string;
  record: FundclearDistributionRecord;
};

export const SOURCE = "FUNDCLEAR_TDCC_OFFSHORE";

export async function writeDistributionBatch(query: QueryFn, candidates: DistributionWriteCandidate[]): Promise<{ written: number; skippedExisting: number; writeErrorCount: number }> {
  if (candidates.length === 0) return { written: 0, skippedExisting: 0, writeErrorCount: 0 };

  const fundIds = [...new Set(candidates.map((c) => c.fundId))];
  const existingRows = await query(
    `SELECT fund_id, ex_date::text AS ex_date FROM fund_distribution_observations WHERE fund_id = ANY($1::text[]) AND source = $2`,
    [fundIds, SOURCE],
  );
  const existingKeys = new Set(existingRows.map((r) => `${r.fund_id}::${r.ex_date}`));

  const toInsert = candidates.filter((c) => !existingKeys.has(`${c.fundId}::${c.record.exDate}`));
  const skippedExisting = candidates.length - toInsert.length;

  let written = 0;
  let writeErrorCount = 0;
  const CHUNK = 200;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    // Per-row try/catch inside each chunk: one bad row (or one bad chunk, if the DB call itself
    // throws) never blocks the rest of this chunk or any other chunk -- same error-isolation
    // convention as every other pipeline this session touched.
    for (const c of chunk) {
      try {
        await query(
          `INSERT INTO fund_distribution_observations
             (id, fund_id, ex_date, record_date, pay_date, distribution_amount, distribution_currency,
              distribution_type, income_component, return_of_capital, source, source_record_id, created_at, updated_at)
           VALUES (gen_random_uuid()::text, $1, $2::date, $3::date, $4::date, $5, $6, 'REGULAR', $7, $8, $9, $10, NOW(), NOW())`,
          [
            c.fundId, c.record.exDate, c.record.baseDate, c.record.payDate,
            c.record.amount, c.currency,
            c.record.incomeRatioPct, c.record.returnOfCapitalRatioPct,
            SOURCE, `${c.fundId}:${c.record.exDate}`,
          ],
        );
        written++;
      } catch {
        writeErrorCount++;
      }
    }
  }
  return { written, skippedExisting, writeErrorCount };
}

export async function writeBatchIfEnabled(query: QueryFn, candidates: DistributionWriteCandidate[], writeEnabled: boolean) {
  if (!writeEnabled) return { written: 0, skippedExisting: 0, writeErrorCount: 0 };
  return writeDistributionBatch(query, candidates);
}
