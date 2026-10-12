// Same no-DDL / SELECT-before-INSERT dedup convention as lib/offshore-dividend-sync/writer.ts. The
// currency gate (row dropped unless SITCA's 配息幣別 matches funds.currency) is applied by the caller
// before candidates ever reach this module -- see route.ts.
import type { DividendMatchResult } from "./types";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export const SOURCE = "SITCA_FSC_OFFICIAL_MONTHLY";

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
  const CHUNK = 200;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    for (const c of chunk) {
      try {
        await query(
          `INSERT INTO fund_distribution_observations
             (id, fund_id, ex_date, record_date, pay_date, distribution_amount, distribution_currency,
              distribution_type, source, source_record_id, created_at, updated_at)
           VALUES (gen_random_uuid()::text, $1, $2::date, $3::date, $4::date, $5, $6, 'REGULAR', $7, $8, NOW(), NOW())`,
          [c.fundId, c.row.exDate, c.row.baseDate, c.row.payDate, c.row.amount, c.sitcaCurrency, SOURCE, `${c.fundId}:${c.row.exDate}`],
        );
        written++;
      } catch {
        writeErrorCount++;
      }
    }
  }
  return { written, skippedExisting, writeErrorCount };
}

export async function writeBatchIfEnabled(query: QueryFn, candidates: DividendMatchResult[], writeEnabled: boolean) {
  if (!writeEnabled) return { written: 0, skippedExisting: 0, writeErrorCount: 0 };
  return writeDividendBatch(query, candidates);
}
