export const TARGET_MODES = ["DYNAMIC_DB_QUERY", "DYNAMIC_DB_QUERY_BOUNDED", "RELEASE_SCHEDULE", "PROVIDER_COHORT", "STATIC_CONFIG", "CANARY", "MANUAL", "UNKNOWN"] as const;
export const UPDATE_MODES = ["CONTINUOUS", "INTRADAY", "DAILY", "TRADING_DAY", "WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL", "RELEASE_DRIVEN", "CHANGE_DETECTED", "STATIC_REFERENCE"] as const;
export const HEALTH_STATES = ["HEALTHY", "RUNNING_BACKFILL", "BACKFILL_COMPLETE_INCREMENTAL_ACTIVE", "DEGRADED", "STALE", "STOPPED_WITH_PENDING", "FALSE_HEALTHY", "SOURCE_LIMITED", "STATIC_SCOPE_TOO_NARROW", "NEW_ASSETS_NOT_AUTO_ENROLLED", "CANONICAL_PROMOTION_LAG", "RETRY_WAIT", "BLOCKED", "NOT_CONFIGURED", "UNKNOWN"] as const;

export type DatasetDefinition = {
  key: string; asset: string; name: string; entity: string; targetMode: typeof TARGET_MODES[number]; auto: "YES" | "NO" | "UNKNOWN";
  provider: string; updateMode: typeof UPDATE_MODES[number]; frequency: string; policy: Record<string, unknown>; graceSeconds?: number;
  universe: string; worker?: string; checkpoint?: string; runtime?: string; canonical: string; raw?: string; priority: number;
  incremental: boolean; backfill: boolean; isEnabled: boolean; schedulerLike?: string; configuredTargetCount?: number;
};

const marketPolicy = { kind: "TRADING_DAY_AWARE", weekendAware: true, holidayAware: true, marketTimezoneRequired: true };
const disclosurePolicy = { kind: "DISCLOSURE_OR_CHANGE_DETECTED", calendarDayExpiry: false };
const releasePolicy = { kind: "RELEASE_SCHEDULE", calendarDayExpiry: false };
const continuousPolicy = { kind: "CONTINUOUS_24_7", maxAgeSeconds: 21_600 };
const businessPolicy = { kind: "BUSINESS_DAY_SOURCE_CADENCE", weekendAware: true };

function d(asset: string, key: string, name: string, canonical: string, options: Partial<DatasetDefinition> = {}): DatasetDefinition {
  return {
    key, asset, name, canonical, entity: `${asset}_MASTER`, targetMode: "DYNAMIC_DB_QUERY", auto: "YES", provider: "EXISTING_PRODUCTION_PIPELINE",
    updateMode: "DAILY", frequency: "P1D", policy: marketPolicy, graceSeconds: 172_800, universe: `production:${asset.toLowerCase()}_master`,
    worker: `existing-${asset.toLowerCase()}-worker`, runtime: `runtime-status/${asset.toLowerCase().replaceAll("_", "-")}.json`, priority: 5,
    incremental: true, backfill: false, isEnabled: true, ...options,
  };
}

export const DATASETS: DatasetDefinition[] = [
  d("STOCK", "STOCK_CURRENT_PRICE", "Stock current price", "stocks", { updateMode: "TRADING_DAY", schedulerLike: "%-yahoo-daily", priority: 1 }),
  d("STOCK", "STOCK_DAILY_HISTORY", "Stock daily history", "stock_history", { updateMode: "TRADING_DAY", schedulerLike: "%-yahoo-daily", backfill: true, priority: 1 }),
  d("STOCK", "STOCK_FINANCIAL_FACTS", "Stock financial facts", "stock_financial_facts", { updateMode: "RELEASE_DRIVEN", frequency: "P3M", policy: releasePolicy, schedulerLike: "official-financial-%", priority: 2 }),
  d("ETF", "ETF_CURRENT_PRICE", "ETF current price", "etfs", { targetMode: "DYNAMIC_DB_QUERY_BOUNDED", schedulerLike: "global_etf-production-daily", priority: 1 }),
  d("ETF", "ETF_DAILY_HISTORY", "ETF daily history", "etf_history", { targetMode: "DYNAMIC_DB_QUERY_BOUNDED", schedulerLike: "global_etf-production-daily", backfill: true, priority: 1 }),
  d("ETF", "ETF_NAV", "ETF NAV", "etf_history", { updateMode: "TRADING_DAY" }),
  d("ETF", "ETF_AUM", "ETF AUM", "etf_asset_metrics", {
    updateMode: "WEEKLY", frequency: "P7D", policy: businessPolicy,
    worker: "ETF_YAHOO_PRODUCT_MODULE_WORKER",
    runtime: "runtime/etf-yahoo-product-modules/checkpoint.json",
    checkpoint: "runtime/etf-yahoo-product-modules/checkpoint.json",
  }),
  d("ETF", "ETF_HOLDINGS", "ETF holdings", "etf_holdings", { updateMode: "CHANGE_DETECTED", frequency: "P1M", policy: disclosurePolicy }),
  d("ETF", "ETF_FLOWS", "ETF flows", "etf_flows", { updateMode: "TRADING_DAY" }),
  d("ETF", "ETF_FEES", "ETF fees", "etfs", { updateMode: "CHANGE_DETECTED", frequency: "P1M", policy: disclosurePolicy }),
  d("ETF", "ETF_DISTRIBUTIONS", "ETF distributions", "etf_distribution_events", { updateMode: "RELEASE_DRIVEN", frequency: "P1M", policy: releasePolicy }),
  d("FUND", "FUND_NAV", "Fund NAV", "funds", { updateMode: "RELEASE_DRIVEN", frequency: "P7D", policy: { kind: "PROVIDER_PUBLICATION_CADENCE" }, graceSeconds: 864_000, priority: 1 }),
  d("FUND", "FUND_PERFORMANCE", "Fund performance", "fund_performances", { updateMode: "WEEKLY", frequency: "P7D", policy: businessPolicy }),
  d("FUND", "FUND_RISK", "Fund risk", "fund_risk_metrics", { updateMode: "MONTHLY", frequency: "P1M", policy: disclosurePolicy }),
  d("FUND", "FUND_HOLDINGS", "Fund holdings", "fund_holdings", { updateMode: "CHANGE_DETECTED", frequency: "P3M", policy: disclosurePolicy }),
  d("FUND", "FUND_NPORT", "Fund N-PORT", "fund_documents", { updateMode: "RELEASE_DRIVEN", frequency: "P3M", policy: releasePolicy, provider: "SEC_NPORT_AND_EXISTING_FUND_SOURCES" }),
  d("INDEX", "INDEX_LEVEL", "Index level", "global_index_registry", { targetMode: "DYNAMIC_DB_QUERY_BOUNDED", schedulerLike: "market_index-production-daily", priority: 1 }),
  d("INDEX", "INDEX_HISTORY", "Index history", "global_index_candles", { targetMode: "DYNAMIC_DB_QUERY_BOUNDED", schedulerLike: "market_index-production-daily", backfill: true, priority: 1 }),
  d("INDEX", "INDEX_CONSTITUENTS", "Index constituents", "global_index_constituents", { targetMode: "PROVIDER_COHORT", auto: "UNKNOWN", updateMode: "RELEASE_DRIVEN", policy: releasePolicy, configuredTargetCount: 21 }),
  d("INDEX", "INDEX_BREADTH", "Index breadth", "market_breadth_observations", { targetMode: "PROVIDER_COHORT", auto: "UNKNOWN" }),
  d("FUTURES", "FUTURES_CONTRACT_HISTORY", "Futures contract history", "futures_observations", { targetMode: "PROVIDER_COHORT", auto: "NO", configuredTargetCount: 5, priority: 1 }),
  d("FUTURES", "FUTURES_SETTLEMENT", "Futures settlement", "futures_settlements", { targetMode: "PROVIDER_COHORT", auto: "NO", configuredTargetCount: 5, priority: 1 }),
  d("FUTURES", "FUTURES_OI", "Futures open interest", "futures_observations", { targetMode: "PROVIDER_COHORT", auto: "NO", configuredTargetCount: 5 }),
  d("FUTURES", "FUTURES_COT", "Futures COT", "futures_positioning_observations", { targetMode: "PROVIDER_COHORT", auto: "NO", updateMode: "WEEKLY", frequency: "P7D", policy: releasePolicy }),
  d("FIXED_INCOME", "FIXED_INCOME_PRICE", "Fixed income price", "bond_market_observations", { targetMode: "PROVIDER_COHORT", auto: "UNKNOWN", configuredTargetCount: 10, policy: businessPolicy }),
  d("FIXED_INCOME", "FIXED_INCOME_YIELD", "Fixed income yield", "bond_market_observations", { targetMode: "PROVIDER_COHORT", auto: "UNKNOWN", configuredTargetCount: 10, schedulerLike: "bond_yield-production-daily", policy: businessPolicy, priority: 1 }),
  d("FIXED_INCOME", "FIXED_INCOME_CURVES", "Fixed income curves", "bond_benchmark_series", { targetMode: "PROVIDER_COHORT", auto: "UNKNOWN", configuredTargetCount: 57, policy: businessPolicy }),
  d("FX", "FX_SPOT", "FX spot", "fx_latest_quotes", { targetMode: "DYNAMIC_DB_QUERY_BOUNDED", updateMode: "INTRADAY", frequency: "PT2H", schedulerLike: "fx-production-daily", priority: 1 }),
  d("FX", "FX_HISTORY", "FX history", "fx_candles", { targetMode: "DYNAMIC_DB_QUERY_BOUNDED", updateMode: "INTRADAY", frequency: "PT2H", schedulerLike: "fx-production-daily", backfill: true, priority: 1 }),
  d("FX", "FX_FORWARD", "FX forward", "fx_forward_observations", { targetMode: "PROVIDER_COHORT", auto: "UNKNOWN", policy: businessPolicy }),
  d("MACRO", "MACRO_VALUES", "Macro values", "economic_values", { targetMode: "RELEASE_SCHEDULE", updateMode: "RELEASE_DRIVEN", frequency: "SOURCE_SCHEDULE", policy: releasePolicy, schedulerLike: "macro-production-daily", priority: 1 }),
  d("MACRO", "MACRO_MONEY_SUPPLY", "Macro money supply", "economic_values", { targetMode: "PROVIDER_COHORT", updateMode: "RELEASE_DRIVEN", frequency: "SOURCE_SCHEDULE", policy: releasePolicy, configuredTargetCount: 10, worker: "MACRO_MONEY_SUPPLY", checkpoint: "runtime/money-supply/checkpoint.json", runtime: "runtime/money-supply/checkpoint.json", priority: 1 }),
  d("MACRO", "MACRO_SOVEREIGN_DEBT", "Macro sovereign debt", "economic_values", { targetMode: "PROVIDER_COHORT", updateMode: "RELEASE_DRIVEN", frequency: "SOURCE_SCHEDULE", policy: releasePolicy, configuredTargetCount: 29, worker: "MACRO_PUBLIC_COUNTRY_BALANCE_SHEET", checkpoint: "runtime/macro-public-country-balance-sheet/checkpoint.json", runtime: "runtime/macro-public-country-balance-sheet/checkpoint.json", priority: 1 }),
  d("MACRO", "MACRO_FISCAL", "Macro fiscal", "economic_values", { targetMode: "PROVIDER_COHORT", updateMode: "RELEASE_DRIVEN", frequency: "SOURCE_SCHEDULE", policy: releasePolicy, configuredTargetCount: 87, worker: "MACRO_PUBLIC_COUNTRY_BALANCE_SHEET", checkpoint: "runtime/macro-public-country-balance-sheet/checkpoint.json", runtime: "runtime/macro-public-country-balance-sheet/checkpoint.json", priority: 1 }),
  d("MACRO", "MACRO_EXTERNAL", "Macro external accounts", "economic_values", { targetMode: "PROVIDER_COHORT", updateMode: "RELEASE_DRIVEN", frequency: "SOURCE_SCHEDULE", policy: releasePolicy, configuredTargetCount: 58, worker: "MACRO_PUBLIC_COUNTRY_BALANCE_SHEET", checkpoint: "runtime/macro-public-country-balance-sheet/checkpoint.json", runtime: "runtime/macro-public-country-balance-sheet/checkpoint.json", priority: 1 }),
  d("MACRO", "MACRO_RESERVES", "Macro reserves", "economic_values", { targetMode: "PROVIDER_COHORT", updateMode: "RELEASE_DRIVEN", frequency: "SOURCE_SCHEDULE", policy: releasePolicy, configuredTargetCount: 58, worker: "MACRO_PUBLIC_COUNTRY_BALANCE_SHEET", checkpoint: "runtime/macro-public-country-balance-sheet/checkpoint.json", runtime: "runtime/macro-public-country-balance-sheet/checkpoint.json", priority: 1 }),
  d("MACRO", "MACRO_CALENDAR", "Macro calendar", "economic_release_events", { targetMode: "RELEASE_SCHEDULE", updateMode: "RELEASE_DRIVEN", frequency: "SOURCE_SCHEDULE", policy: releasePolicy }),
  d("COMMODITY_REAL_ASSET", "COMMODITY_REFERENCE_PRICE", "Commodity reference price", "commodity_observations", { targetMode: "PROVIDER_COHORT", updateMode: "RELEASE_DRIVEN", policy: releasePolicy, schedulerLike: "commodity-production-daily" }),
  d("CRYPTO", "CRYPTO_PRICE", "Crypto price", "crypto_candles", { targetMode: "DYNAMIC_DB_QUERY_BOUNDED", updateMode: "CONTINUOUS", frequency: "PT5M", policy: continuousPolicy, graceSeconds: 21_600, schedulerLike: "crypto-production-daily", priority: 1 }),
  d("CRYPTO", "CRYPTO_MARKET_CAP", "Crypto market cap", "crypto_market_cap_supply", { targetMode: "PROVIDER_COHORT", updateMode: "CONTINUOUS", frequency: "PT1H", policy: continuousPolicy }),
  d("CRYPTO", "CRYPTO_FUNDING", "Crypto funding", "crypto_metrics", { targetMode: "PROVIDER_COHORT", updateMode: "INTRADAY", frequency: "PT8H", policy: continuousPolicy }),
  d("CRYPTO", "CRYPTO_OI", "Crypto open interest", "crypto_metrics", { targetMode: "PROVIDER_COHORT", updateMode: "INTRADAY", frequency: "PT1H", policy: continuousPolicy }),
  d("CRYPTO", "CRYPTO_ONCHAIN", "Crypto on-chain", "crypto_metrics", { targetMode: "PROVIDER_COHORT", updateMode: "DAILY", frequency: "P1D", policy: continuousPolicy }),
  d("MOPS", "MOPS_COMPANY_DATA", "MOPS company data", "stock_financial_facts", { targetMode: "DYNAMIC_DB_QUERY_BOUNDED", updateMode: "RELEASE_DRIVEN", frequency: "SOURCE_SCHEDULE", policy: releasePolicy, provider: "MOPS", worker: "run-isolated-mops-ingestion", runtime: "runtime/mops", priority: 2 }),
];
