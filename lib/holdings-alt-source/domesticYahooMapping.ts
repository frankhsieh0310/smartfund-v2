// Domestic-fund Yahoo mapping: unlike offshore (which needed a dedicated Yahoo-symbol discovery sweep,
// seeded into offshore-nav-sync:yahoo-mapping), domestic funds already have a usable mapping sitting in
// the EXISTING fund_provider_mappings table (provider='yahoo') -- its provider_code values were assumed
// unusable for Yahoo lookups by an earlier investigation (see lib/cloud-ingestion/fundNav.ts comment:
// "not Yahoo symbols, yahoo-finance2 .quote() returns quoteType UNKNOWN"), but that conclusion was about
// yahoo-finance2's stock-quote API specifically. Confirmed live 2026-10-13: appending ":FO" to the same
// provider_code works directly as this module's yahooFundId for the fund-summary-page scrape (same ID
// space Yahoo's own fund pages use) -- 50/50 funds hit in a dry run. No new discovery sweep needed.
export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type DomesticMappingEntry = {
  fundId: string;
  code: string;
  yahooFundId: string;
};

export async function loadDomesticYahooMapping(query: QueryFn): Promise<DomesticMappingEntry[]> {
  const rows = await query(
    `SELECT fpm.fund_id AS "fundId", f.code AS "code", fpm.provider_code AS "providerCode"
       FROM fund_provider_mappings fpm
       JOIN funds f ON f.id = fpm.fund_id
      WHERE fpm.provider = 'yahoo'
        AND COALESCE(f.data_provider, '') NOT IN ('yahoo', 'SEC', 'tdcc-offshore')
        AND fpm.provider_code IS NOT NULL`,
    [],
  );
  return rows.map((r) => ({ fundId: r.fundId, code: r.code, yahooFundId: `${r.providerCode}:FO` }));
}
