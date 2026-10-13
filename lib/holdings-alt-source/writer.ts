// Writes into the EXISTING `holdings` table (no DDL), same conflict key convention as
// moneydjFundDisclosure.ts: (fund_id, source, filing_id, source_record_id). A distinct `source` value
// per provider means this never collides with or overwrites MoneyDJ-sourced rows for the same fund --
// both can coexist, which is the point (compare before cutting over).
import type { YahooFundHoldings } from "./yahooOffshoreHoldings";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export async function writeYahooOffshoreHoldings(
  query: QueryFn,
  source: string,
  input: { fundId: string; yahooFundId: string; holdings: YahooFundHoldings },
  writeEnabled: boolean,
): Promise<{ written: number }> {
  if (!writeEnabled) return { written: 0 };
  const { fundId, yahooFundId, holdings } = input;
  const asOfDate = holdings.asOfDate ?? new Date().toISOString().slice(0, 10);
  const filingId = `yahoo:${yahooFundId.toLowerCase()}:${asOfDate}`;

  let written = 0;
  for (const h of holdings.holdings) {
    const sourceRecordId = `${asOfDate}:${h.rank}:${h.securityName}`;
    const rows = await query(
      `INSERT INTO holdings
         (id, asset_type, fund_id, as_of_date, rank, holding_name, holding_code,
          weight, source, source_record_id, filing_id, weight_method, created_at)
       VALUES (gen_random_uuid()::text, 'FUND', $1, $2::date, $3, $4, $5, $6, $7, $8, $9, 'TOP_N_DISCLOSED', CURRENT_TIMESTAMP)
       ON CONFLICT (fund_id, source, filing_id, source_record_id)
         WHERE fund_id IS NOT NULL AND source IS NOT NULL AND filing_id IS NOT NULL AND source_record_id IS NOT NULL
       DO UPDATE SET rank = EXCLUDED.rank, holding_name = EXCLUDED.holding_name, weight = EXCLUDED.weight
       RETURNING id`,
      [fundId, asOfDate, h.rank, h.securityName, h.ticker, h.weightPct, source, sourceRecordId, filingId],
    );
    written += rows.length;
  }
  return { written };
}
