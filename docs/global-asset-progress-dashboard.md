# SmartFund Global Asset Progress Dashboard

> Generated automatically at **2026-08-01T11:14:34.209Z**. Coverage baseline is the already-completed Global Data Audit **2026-08-01T10-06-12-466Z**; this dashboard does **not** rerun that audit. Production lifecycle evidence is refreshed from the small Run Ledger only. Unknown required gates score 0 and are never guessed.

## Global Production: 31.93%

Current asset: **Stocks**

| Order | Asset | Universe | Historical | Latest | Rows | Earliest | Latest Date | Production | Status | Main Gap |
| ---: | --- | ---: | --- | --- | ---: | --- | --- | ---: | --- | --- |
| 1 | Stocks | 80,944 | 80,940 / 80,944 (99.9951%) | 34,495 / 80,944 (42.6159%) | 110,576,445 | UNKNOWN | 2026-07-31 | 43.93% | PARTIAL | Per-stock coverage is UNKNOWN because the completed audit query exceeded the production statement timeout |
| 2 | ETF | 12,802 | 12,685 / 12,802 (99.0861%) | 4,800 / 12,453 (38.5449%) | 13,355,179 | 1993-01-29 | 2026-07-31 | 23.76% | PARTIAL | 695 NAV rows exist, but product coverage was not verified |
| 3 | Fund | 12,035 | 11,815 / 12,035 (98.1720%) | 11,732 / 12,035 (97.4823%) | 19,470,555 | 2003-11-01 | 2026-07-31 | 36.96% | PARTIAL | 0 canonical fund distribution products in the completed audit |
| 4 | Government Yield | 5 | 5 / 5 (100.0000%) | 5 / 5 (100.0000%) | 54,834 | 1970-01-02 | 2026-07-30 | 80.00% | PARTIAL | 5 configured; full target universe is not registered |
| 5 | Economic Data | 155 | 155 / 155 (100.0000%) | 27 / 155 (17.4194%) | 74,588 | 1947-01-01 | 2026-08-01 | 69.57% | PARTIAL | 0/74588 rows retain revision history; vintage observations are not preserved |
| 6 | Commodity | 12 | 8 / 12 (66.6667%) | 0 / 12 (0.0000%) | 52,556 | 2000-01-03 | 2026-07-10 | 13.33% | PARTIAL | 12 configured; full target universe is not registered |
| 7 | FX | 21 | 11 / 21 (52.3810%) | 0 / 21 (0.0000%) | 68,221 | 1971-01-04 | 2026-07-11 | 10.48% | PARTIAL | 21 configured; full target universe is not registered |
| 8 | Crypto | 15 | 7 / 15 (46.6667%) | 0 / 15 (0.0000%) | 22,435 | 2014-09-17 | 2026-07-11 | 9.33% | PARTIAL | 15 configured; full target universe is not registered |
| 9 | Bond | 0 | 0 / 0 (0.0000%) | 0 / 0 (0.0000%) | 0 | UNKNOWN | UNKNOWN | 0.00% | NOT_STARTED | 0 configured; full target universe is not registered |

## Production Gates

### 1. Stocks

| Gate | Completed | Expected | Coverage | Evidence |
| --- | ---: | ---: | ---: | --- |
| Universe | 80,944 | 80,944 | 100.0000% | 80,944 registered stocks |
| Historical Price | 80,940 | 80,944 | 99.9951% | 80940/80944 |
| Daily Price | 34,495 | 80,944 | 42.6159% | 34495/80944 in latest market runs |
| Financial Statements | UNKNOWN | 80,944 | 0.0000% | Per-stock coverage is UNKNOWN because the completed audit query exceeded the production statement timeout |
| Corporate Actions | 0 | 80,944 | 0.0000% | No canonical stock corporate-action production ledger |
| Derived Metrics | 100 | 80,944 | 0.1235% | 100/80944; lower-bound evidence only |
| Validation | 9 | 23 | 39.1304% | 9/23 market latest runs validated PASS |
| Production Scheduler | 16 | 23 | 69.5652% | 16/23 markets scheduler-enabled |

### 2. ETF

| Gate | Completed | Expected | Coverage | Evidence |
| --- | ---: | ---: | ---: | --- |
| Universe | 12,802 | 12,802 | 100.0000% | 12802 registered ETFs |
| Historical Price | 12,685 | 12,802 | 99.0861% | 12685/12802 |
| Daily Price | 4,800 | 12,453 | 38.5449% | PAUSED |
| NAV | UNKNOWN | 12,802 | 0.0000% | 695 NAV rows exist, but product coverage was not verified |
| Distribution | 0 | 12,802 | 0.0000% | 0 ETF products with canonical distributions in the completed audit |
| Holdings | 0 | 12,802 | 0.0000% | 0 ETF products with canonical holdings in the completed audit |
| Corporate Actions | 0 | 12,802 | 0.0000% | No complete ETF corporate-action production evidence |
| Derived Metrics | 0 | 12,802 | 0.0000% | No complete ETF derived-metric production evidence |
| Validation | 0 | 6 | 0.0000% | Regional validation evidence |
| Production Scheduler | 0 | 1 | 0.0000% | PAUSED |

### 3. Fund

| Gate | Completed | Expected | Coverage | Evidence |
| --- | ---: | ---: | ---: | --- |
| Universe | 12,035 | 12,035 | 100.0000% | 12035 registered funds |
| Historical NAV | 11,815 | 12,035 | 98.1720% | 11815/12035 |
| Daily NAV | 11,732 | 12,035 | 97.4823% | 11732/12035 |
| Distribution | 0 | 12,035 | 0.0000% | 0 canonical fund distribution products in the completed audit |
| Portfolio | 0 | 12,035 | 0.0000% | 0 canonical fund holding products in the completed audit |
| Characteristics | 0 | 12,035 | 0.0000% | Domicile/share-class characteristics are not normalized |
| Validation | 0 | 1 | 0.0000% | NO_PRODUCTION_RUN_LEDGER |
| Production Scheduler | 0 | 1 | 0.0000% | MoneyDJ job is CONFIG_ONLY; not called by Railway production cron |

### 4. Government Yield

| Gate | Completed | Expected | Coverage | Evidence |
| --- | ---: | ---: | ---: | --- |
| Universe | 0 | 1 | 0.0000% | 5 configured; full target universe is not registered |
| Historical | 5 | 5 | 100.0000% | 5/5 |
| Incremental | 5 | 5 | 100.0000% | COMPLETED |
| Validation | 1 | 1 | 100.0000% | PASS |
| Production Scheduler | 1 | 1 | 100.0000% | Railway cron */5; provider-latest adapter |

### 5. Economic Data

| Gate | Completed | Expected | Coverage | Evidence |
| --- | ---: | ---: | ---: | --- |
| Universe | 155 | 155 | 100.0000% | 155 registered instruments/series |
| Historical | 155 | 155 | 100.0000% | 155/155 |
| Revision History | 0 | 74,588 | 0.0000% | 0/74588 rows retain revision history; vintage observations are not preserved |
| Incremental | 27 | 155 | 17.4194% | COMPLETED |
| Validation | 1 | 1 | 100.0000% | PASS |
| Production Scheduler | 1 | 1 | 100.0000% | Railway cron */5; adapters currently executable for FRED/ECB |

### 6. Commodity

| Gate | Completed | Expected | Coverage | Evidence |
| --- | ---: | ---: | ---: | --- |
| Universe | 0 | 1 | 0.0000% | 12 configured; full target universe is not registered |
| Historical | 8 | 12 | 66.6667% | 8/12 |
| Incremental | 0 | 12 | 0.0000% | NOT_STARTED |
| Validation | 0 | 1 | 0.0000% | NOT_RUN |
| Production Scheduler | 0 | 1 | 0.0000% | Provider registry exists, but runner does not dispatch this asset class |

### 7. FX

| Gate | Completed | Expected | Coverage | Evidence |
| --- | ---: | ---: | ---: | --- |
| Universe | 0 | 1 | 0.0000% | 21 configured; full target universe is not registered |
| Historical | 11 | 21 | 52.3810% | 11/21 |
| Incremental | 0 | 21 | 0.0000% | NOT_STARTED |
| Validation | 0 | 1 | 0.0000% | NOT_RUN |
| Production Scheduler | 0 | 1 | 0.0000% | Provider registry exists, but runner does not dispatch this asset class |

### 8. Crypto

| Gate | Completed | Expected | Coverage | Evidence |
| --- | ---: | ---: | ---: | --- |
| Universe | 0 | 1 | 0.0000% | 15 configured; full target universe is not registered |
| Historical | 7 | 15 | 46.6667% | 7/15 |
| Incremental 24/7 | 0 | 15 | 0.0000% | NOT_STARTED |
| Validation | 0 | 1 | 0.0000% | NOT_RUN |
| Production Scheduler | 0 | 1 | 0.0000% | Provider registry exists, but runner does not dispatch this asset class |

### 9. Bond

| Gate | Completed | Expected | Coverage | Evidence |
| --- | ---: | ---: | ---: | --- |
| Universe | 0 | 1 | 0.0000% | 0 configured; full target universe is not registered |
| Historical | 0 | 0 | 0.0000% | 0/0 |
| Spread | 0 | 1 | 0.0000% | No canonical bond spread production evidence |
| Incremental | 0 | 0 | 0.0000% | NOT_STARTED |
| Validation | 0 | 1 | 0.0000% | NOT_RUN |
| Production Scheduler | 0 | 1 | 0.0000% | NOT_CONFIGURED |
