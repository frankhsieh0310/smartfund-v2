# SmartFund Non-Stock Data Asset Coverage Audit

- Generated (UTC): 2026-07-29T14:10:11.179Z
- Mode: **read-only production audit**. No worker, scheduler, checkpoint, queue, or production data was modified.
- Scope: non-stock asset classes only. A local raw archive is not treated as proof of production ingestion.

## Coverage summary

| Asset Class | Universe / Master Count | Historical Product Count | Historical Row Count | Coverage | Earliest | Latest | Source / Provenance | Current Status | Blocking Issue |
|---|---:|---:|---:|---|---|---|---|---|---|
| Taiwan ETF | 349 | 232 | 343173 | 232 / 349 (66.48%) | 2008-01-02 | 2026-07-24 | UNVERIFIABLE_MASTER_METADATA; etf_history has no per-row source/provider field; master source fields contain symbols/codes rather than normalized provenance | PARTIAL_HISTORICAL | No production daily job or ETF lifecycle evidence |
| US / Global ETF | 12453 | 12453 | 12996735 | 12453 / 12453 (100.00%) | 1993-01-29 | 2026-07-23 | UNVERIFIABLE_MASTER_METADATA; etf_history has no per-row source/provider field; master source fields contain symbols/codes rather than normalized provenance | HISTORICAL_READY_WITH_EXCEPTIONS | No production daily job or ETF lifecycle evidence |
| Mutual Funds | 12035 | 11815 | 19470537 | 11815 / 12035 (98.17%) | 2003-11-01 | 2026-07-28 | UNVERIFIABLE_MASTER_METADATA; fund_history has no per-row source/provider field; master source fields contain codes rather than normalized provenance | PARTIAL_HISTORICAL | Master-to-history coverage and provenance are incomplete; no production daily job |
| Macro | 155 | 155 | 74508 | 155 / 155 (100.00%) | 1947-01-01 | 2026-07-28 | ECB, FRED, IMF, OECD, World Bank; economic_values includes source_url/source_version/raw_checksum/imported_at | HISTORICAL_READY_WITH_EXCEPTIONS | No macro provider production scheduler/execution evidence |
| Global Stock Indices | 26 | 25 | 188767 | 25 / 26 (96.15%) | 1965-01-05 | 2026-07-29 | YAHOO_CHART, YAHOO_HTML; index_history includes provider/provider_symbol/raw_payload_reference/imported_at | PARTIAL_HISTORICAL | No index production daily scheduler/execution evidence |
| REITs | 0 | 0 | 0 | 0 / 0 | UNKNOWN | UNKNOWN | NONE_OR_UNAVAILABLE; asset_performances has no per-row source/provider field | SCHEMA_ONLY | No dedicated REIT historical/daily lifecycle evidence |
| Insurance Products (other existing asset class) | 456 | 442 | 19230 | 442 / 456 (96.93%) | 2016-11-06 | 2026-07-07 | NOT_MODELED; insurance_history has no per-row source/provider field | PARTIAL_HISTORICAL | No source provenance or production lifecycle evidence |
| Bond Indices / Yields | 5 | 5 | 54819 | 5 / 5 (100.00%) | 1970-01-02 | 2026-07-10 | yahoo-finance2; market_history has no per-row source/provider field; provider is master-level only | HISTORICAL_READY_WITH_EXCEPTIONS | No non-stock market-data production scheduler/execution evidence |
| Commodities (non-energy, non-precious) | 12 | 8 | 52556 | 8 / 12 (66.67%) | 2000-01-03 | 2026-07-10 | YAHOO_CHART, yahoo-finance2; market_history has no per-row source/provider field; provider is master-level only | PARTIAL_HISTORICAL | No non-stock market-data production scheduler/execution evidence |
| Crypto | 15 | 7 | 22435 | 7 / 15 (46.67%) | 2014-09-17 | 2026-07-11 | YAHOO_CHART, yahoo-finance2; market_history has no per-row source/provider field; provider is master-level only | PARTIAL_HISTORICAL | No non-stock market-data production scheduler/execution evidence |
| FX | 21 | 11 | 68221 | 11 / 21 (52.38%) | 1971-01-04 | 2026-07-11 | YAHOO_CHART, yahoo-finance2; market_history has no per-row source/provider field; provider is master-level only | PARTIAL_HISTORICAL | No non-stock market-data production scheduler/execution evidence |
| Market Indices (market_master) | 29 | 29 | 255363 | 29 / 29 (100.00%) | 1970-01-02 | 2026-07-10 | yahoo-finance2; market_history has no per-row source/provider field; provider is master-level only | HISTORICAL_READY_WITH_EXCEPTIONS | No non-stock market-data production scheduler/execution evidence |
| Oil / Energy Commodities | 8 | 5 | 30649 | 5 / 8 (62.50%) | 2000-08-23 | 2026-07-10 | YAHOO_CHART, yahoo-finance2; market_history has no per-row source/provider field; provider is master-level only | PARTIAL_HISTORICAL | No non-stock market-data production scheduler/execution evidence |
| Precious Metals / Metal Indices | 8 | 4 | 26021 | 4 / 8 (50.00%) | 1997-10-29 | 2026-07-10 | YAHOO_CHART, yahoo-finance2; market_history has no per-row source/provider field; provider is master-level only | PARTIAL_HISTORICAL | No non-stock market-data production scheduler/execution evidence |
| Volatility / Other Market Indicators | 1 | 1 | 9198 | 1 / 1 (100.00%) | 1990-01-02 | 2026-07-10 | yahoo-finance2; market_history has no per-row source/provider field; provider is master-level only | HISTORICAL_READY_WITH_EXCEPTIONS | No non-stock market-data production scheduler/execution evidence |

## Cross-validation evidence

- Prisma schema: `prisma/schema.prisma`; migrations include production lifecycle migrations through `20260729120000_add_provider_symbol_mapping_registry`.
- Production daily config: `twse-yahoo-daily, tpex-yahoo-daily, nasdaq-yahoo-daily, nyse-yahoo-daily`. It contains stock-exchange jobs only; it does not evidence production scheduling for the audited non-stock classes.
- Historical job ledger rows: `[
  {
    "provider": "yahoo",
    "status": "COMPLETED",
    "count": "1",
    "latest": "2026-07-25T01:41:32.190Z"
  },
  {
    "provider": "yahoo",
    "status": "RUNNING",
    "count": "1",
    "latest": "2026-07-25T06:05:04.890Z"
  }
]`.
- Historical failure queue rows: `[]`.
- Local archive directories: `{
  "debug": true,
  "data": true,
  "raw": false
}`; these are explicitly not production evidence.
- Mock/sample/test signal in `market_data`: `0`. This table is reported as a signal only, not merged into canonical history.
- Production API probes: `[
  {
    "path": "/api/etfs?limit=1",
    "status": 404
  },
  {
    "path": "/api/funds?limit=1",
    "status": 404
  },
  {
    "path": "/api/economic-series?limit=1",
    "status": 404
  }
]`. A local route's presence is not treated as evidence that the production deployment is serving it.

## Provenance limitations

- `index_history` and `economic_values` retain row-level provenance fields.
- `etf_history`, `fund_history`, `market_history`, `asset_performances`, and `insurance_history` do not retain an equivalent per-row provider/source field in the current schema. Master-level provider fields cannot prove every historical row's origin.
- A query timeout is reported as `UNKNOWN`; it is never converted into a completion claim.

## Detailed lifecycle evidence

### Taiwan ETF
- Historical worker: Scripts found by repository scan: etfs + etf_history (Taiwan); no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: /api/etfs and /api/etfs/[id]/history exist (not production-called by this audit); Production HTTP 404
- Query errors: none

### US / Global ETF
- Historical worker: Scripts found by repository scan: etfs + etf_history (global); no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: /api/etfs and /api/etfs/[id]/history exist (not production-called by this audit); Production HTTP 404
- Query errors: none

### Mutual Funds
- Historical worker: Scripts found by repository scan: funds + fund_history; no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: /api/funds and /api/funds/[id]/nav exist (not production-called by this audit); Production HTTP 404
- Query errors: none

### Macro
- Historical worker: Scripts found by repository scan: economic_series + economic_values; no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: /api/economic-series and /api/economic-series/[id]/history exist (not production-called by this audit); Production HTTP 404
- Query errors: none

### Global Stock Indices
- Historical worker: Scripts found by repository scan: market_indexes + index_history; no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: No dedicated market-index API route found in repository scan; No matching production API probe
- Query errors: none

### REITs
- Historical worker: Scripts found by repository scan: assets + asset_performances (REIT); no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: No dedicated REIT history API route found in repository scan; No matching production API probe
- Query errors: none

### Insurance Products (other existing asset class)
- Historical worker: Scripts found by repository scan: insurance_products + insurance_history; no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: No dedicated insurance history API route found in repository scan; No matching production API probe
- Query errors: none

### Bond Indices / Yields
- Historical worker: Scripts found by repository scan: market_master + market_history; no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: No dedicated API production verification in this audit; No matching production API probe
- Query errors: none

### Commodities (non-energy, non-precious)
- Historical worker: Scripts found by repository scan: market_master + market_history; no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: No dedicated API production verification in this audit; No matching production API probe
- Query errors: none

### Crypto
- Historical worker: Scripts found by repository scan: market_master + market_history; no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: No dedicated API production verification in this audit; No matching production API probe
- Query errors: none

### FX
- Historical worker: Scripts found by repository scan: market_master + market_history; no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: No dedicated API production verification in this audit; No matching production API probe
- Query errors: none

### Market Indices (market_master)
- Historical worker: Scripts found by repository scan: market_master + market_history; no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: No dedicated API production verification in this audit; No matching production API probe
- Query errors: none

### Oil / Energy Commodities
- Historical worker: Scripts found by repository scan: market_master + market_history; no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: No dedicated API production verification in this audit; No matching production API probe
- Query errors: none

### Precious Metals / Metal Indices
- Historical worker: Scripts found by repository scan: market_master + market_history; no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: No dedicated API production verification in this audit; No matching production API probe
- Query errors: none

### Volatility / Other Market Indicators
- Historical worker: Scripts found by repository scan: market_master + market_history; no production run-ledger linkage evidenced
- Raw archive: No local raw/archive directory found
- Checkpoint / Resume: No dedicated production lifecycle checkpoint evidenced / No dedicated production resume evidence
- Failure queue / Validation / Summary: history_failed_queue exists; asset-specific linkage not evidenced / No production validation record evidenced / No production historical summary evidenced
- Daily worker / Scheduler: Repository script may exist; no production execution evidenced / Not configured in production-yahoo-daily-jobs.json
- Website API: No dedicated API production verification in this audit; No matching production API probe
- Query errors: none

