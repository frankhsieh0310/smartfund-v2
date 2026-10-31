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
  // 2026-10-31（VERIFIED根因，HOLDINGS_ALT_SOURCE_SYNC連續失敗修正）: 532/1,824筆
  // provider_code本身已經帶了":FO"字尾(source='YAHOO_TW_FUND_SEARCH_EXACT_NAME'寫入時就加過)，
  // 這裡無條件再加一次變成"F000016C6D:FO:FO"——該ID在Yahoo奇摩基金頁面回404(VERIFIED)，被
  // fetchYahooOffshoreHoldings當成「沒有持股資料」，連續抽到5檔這種壞ID就整輪FAILED，跟基金
  // 本身有沒有持股無關。改成只在provider_code還沒有:FO字尾時才加。
  return rows.map((r) => ({ fundId: r.fundId, code: r.code, yahooFundId: r.providerCode.endsWith(":FO") ? r.providerCode : `${r.providerCode}:FO` }));
}
