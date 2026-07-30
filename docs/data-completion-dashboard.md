# SmartFund Data Completion Dashboard

> Generated from canonical Supabase tables and Production Run Ledger at **2026-07-30T01:36:03.472Z**. Do not edit manually; the Production Coordinator rebuilds it after every Cron pass. Metric mode: **FAST_CANONICAL** (fast mode uses canonical master flags to protect Daily from multi-million-row scans; `--deep` runs an exact audit).

## Global Completion: 59.75%

- Stocks: **88.45%**
- ETF: **62.11%**
- Funds: **63.61%**
- Macro: **100%**
- Index: **50%**
- Bond: **100%**
- Commodity: **55%**
- FX: **55%**
- Crypto: **55%**
- Volatility: **100%**
- Precious Metal: **0%**
- Energy: **0%**
- Insurance: **0%**
- REIT: **0%**

## Asset Completion

| Asset | Universe | Historical | Daily | Production | API | Provider | Latest Date | Status | Completion | Blocking Issue | Next Task |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- |
| TWSE | 1088 | 1088/1088 (100%) | ACTIVE | PASS | /api/stocks | YAHOO_CHART | 2026-07-29 | PRODUCT_READY | 100% | Historical and Daily lifecycle evidence determines readiness. | Historical and Daily lifecycle evidence determines readiness. |
| TPEx | 889 | 889/889 (100%) | ACTIVE | PASS | /api/stocks | YAHOO_CHART | 2026-07-29 | PRODUCT_READY | 100% | Historical and Daily lifecycle evidence determines readiness. | Historical and Daily lifecycle evidence determines readiness. |
| NASDAQ | 3562 | 3561/3562 (99.97%) | ACTIVE | PASS | /api/stocks | YAHOO_CHART | 2026-07-29 | PRODUCT_READY | 99.98% | Historical and Daily lifecycle evidence determines readiness. | Historical and Daily lifecycle evidence determines readiness. |
| NYSE | 2610 | 2608/2610 (99.92%) | IN_PROGRESS | NOT_VERIFIED | /api/stocks | YAHOO_CHART | 2026-07-29 | DAILY_ACTIVE | 77.46% | Historical and Daily lifecycle evidence determines readiness. | Historical and Daily lifecycle evidence determines readiness. |
| AMEX | 287 | 286/287 (99.65%) | NOT_STARTED | NOT_VERIFIED | /api/stocks | YAHOO_CHART | 2026-07-28 | HISTORICAL_READY | 64.81% | Historical and Daily lifecycle evidence determines readiness. | Historical and Daily lifecycle evidence determines readiness. |
| Taiwan ETF | 349 | 233/349 (66.76%) | NOT_STARTED | NOT_VERIFIED | /api/etfs | YAHOO_CHART | 2026-07-11 | PARTIAL_HISTORICAL | 46.72% | Historical coverage and a dedicated Daily lifecycle are absent. | Historical coverage and a dedicated Daily lifecycle are absent. |
| Global ETF | 12453 | 12453/12453 (100%) | PAUSED | NOT_VERIFIED | /api/etfs | YAHOO_CHART | 2026-07-30 | DAILY_ACTIVE | 77.5% | Finish the resumable whole-universe Daily validation. | Finish the resumable whole-universe Daily validation. |
| Mutual Funds | 12035 | 11732/12035 (97.48%) | NOT_STARTED | NOT_VERIFIED | /api/funds | MAPPING_PENDING | 2026-07-25 | PARTIAL_HISTORICAL | 63.61% | Provider mapping, provenance, and Production Daily are not complete. | Provider mapping, provenance, and Production Daily are not complete. |
| Macro (all providers) | 155 | 155/155 (100%) | ACTIVE | PASS | /api/economic-series | FRED/ECB + PROVIDER_PENDING | 2026-07-29 | PRODUCT_READY | 100% | IMF/OECD/World Bank remain PROVIDER_PENDING; FRED/ECB are independently active. | IMF/OECD/World Bank remain PROVIDER_PENDING; FRED/ECB are independently active. |
| Global Stock Index | 26 | 0/26 (0%) | NOT_STARTED | NOT_VERIFIED | — | YAHOO_CHART | — | MASTER_ONLY | 0% | No Production Daily lifecycle/API bridge. | No Production Daily lifecycle/API bridge. |
| Index | 29 | 29/29 (100%) | ACTIVE | PASS | /api/market-indices | YAHOO_CHART | 2026-07-29 | PRODUCT_READY | 100% | Record current Production validation. | Record current Production validation. |
| Bond | 5 | 5/5 (100%) | ACTIVE | PASS | /api/bond-yields | FRED/ECB | 2026-07-10 | PRODUCT_READY | 100% | Record current Production validation. | Record current Production validation. |
| Commodity | 28 | 28/28 (100%) | NOT_STARTED | NOT_VERIFIED | — | YAHOO_CHART | 2026-07-27 | HISTORICAL_READY | 55% | No dedicated Production Daily or API. | No dedicated Production Daily or API. |
| FX | 21 | 21/21 (100%) | NOT_STARTED | NOT_VERIFIED | — | YAHOO_CHART | 2026-07-27 | HISTORICAL_READY | 55% | No dedicated Production Daily or API. | No dedicated Production Daily or API. |
| Crypto | 15 | 15/15 (100%) | NOT_STARTED | NOT_VERIFIED | — | YAHOO_CHART | 2026-07-27 | HISTORICAL_READY | 55% | No dedicated Production Daily or API. | No dedicated Production Daily or API. |
| Volatility | 1 | 1/1 (100%) | ACTIVE | PASS | /api/volatility | YAHOO_CHART | 2026-07-10 | PRODUCT_READY | 100% | Record current Production validation. | Record current Production validation. |
| Precious Metals | 0 | 0/0 (0%) | NOT_STARTED | NOT_VERIFIED | — | YAHOO_CHART | — | NOT_STARTED | 0% | Complete historical coverage, Daily lifecycle, and API. | Complete historical coverage, Daily lifecycle, and API. |
| Energy / Oil | 0 | 0/0 (0%) | NOT_STARTED | NOT_VERIFIED | — | YAHOO_CHART | — | NOT_STARTED | 0% | Complete historical coverage, Daily lifecycle, and API. | Complete historical coverage, Daily lifecycle, and API. |
| Insurance | 456 | 0/456 (0%) | NOT_STARTED | NOT_VERIFIED | — | PROVIDER_PENDING | — | MASTER_ONLY | 0% | Historical exceptions, provenance, Production Daily, and API are incomplete. | Historical exceptions, provenance, Production Daily, and API are incomplete. |
| REIT | 0 | 0/0 (0%) | NOT_STARTED | NOT_VERIFIED | — | NOT_CONFIGURED | — | NOT_STARTED | 0% | No dedicated Master, canonical history, Daily lifecycle, or API. | No dedicated Master, canonical history, Daily lifecycle, or API. |

## Next Task

**Global ETF** — Finish the resumable whole-universe Daily validation.
