# SmartFund Global Data Dictionary

This dictionary is the data-platform contract for the current production model. Status reflects actual production evidence as of 2026-07-31, not planned capability. `Complete` means the field exists in the canonical table; it does not imply every global symbol has a complete history.

| Category | Field / field family | Canonical location | Status | Current source | Refresh | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Identity | Stock ID | `stocks.id` | Complete | SmartFund master | On discovery | Primary identity |
| Identity | Ticker / Yahoo symbol | `stocks.ticker`, `stocks.yahoo_symbol` | Complete | Universe + Yahoo mapping | On discovery/repair | Original symbol is not a separate column |
| Identity | Company name | `stocks.company_name`, `company_name_zh` | Complete | Universe master | On discovery | |
| Identity | Exchange / country / currency | `stocks.exchange`, `country`, `currency` | Complete | Universe master / Yahoo | On discovery | Market is inferred from exchange/country |
| Identity | Sector / industry / active status | `stocks.sector`, `industry`, `is_active`, `status` | Complete | Universe master | On discovery/maintenance | Inactive count was 0 in audited markets |
| Price | Trade date | `stock_history.date` | Complete | Yahoo Chart | Daily incremental | Unique with stock ID |
| Price | Open / high / low / close | `stock_history` | Complete | Yahoo Chart | Daily incremental | Global historical evidence: 99.994% of requested master |
| Price | Adjusted close | `stock_history.adjusted_close` | Complete | Yahoo Chart | Daily incremental | Adjusted series is not a raw corporate-action ledger |
| Price | Volume | `stock_history.volume` | Complete | Yahoo Chart | Daily incremental | |
| Price | Price provenance | `stock_history.source`, `source_symbol`, `provider_method` | Complete | Yahoo Chart | Every write | |
| Price | Imported / updated timestamp | `stock_history.imported_at`, `updated_at` | Complete | SmartFund | Every write | |
| Price telemetry | HTTP status / response type / parser version | Run artifacts, not price row | Partial | Yahoo worker diagnostics | Per request | Not currently canonical per-row fields |
| Price telemetry | Staleness / validation result | Run validation, not price row | Partial | Scheduler lifecycle | Per run | Provider-latest policy used where runs validate |
| Lifecycle | Run ID / job ID / lock / checkpoint / retry / failure | `production_scheduler_*` tables | Complete | SmartFund lifecycle | Every run | Isolated by market job ID |
| Corporate action | Cash dividend | `stock_financial_facts` metric `yahoo.event.cashDividend` | Prototype | Yahoo Chart | Event-driven / daily | 3 symbols at snapshot |
| Corporate action | Stock split | `stock_financial_facts` metric `yahoo.event.splitRatio` | Prototype | Yahoo Chart | Event-driven / daily | 2 symbols at snapshot |
| Corporate action | Ex-date / record date / payment date | No canonical event table | Not started | Proposed Yahoo + official adapters | Daily | Requires dedicated event model |
| Corporate action | Rights / bonus / capital reduction | No canonical event table | Not started | Official market sources | Event-driven | |
| Corporate action | Symbol change / rename / listing / delisting | Stock master status only | Partial | Universe maintenance | Maintenance | No event history/lineage table |
| Financial raw | Revenue | `stock_financial_facts` | Partial historical | SEC EDGAR | Quarterly/annual | 571 stocks at snapshot |
| Financial raw | Cost of revenue / gross profit | `stock_financial_facts` | Prototype | SEC / official filings | Quarterly/annual | Schema supports it; no global coverage proof |
| Financial raw | Operating income / EBIT / EBITDA / pretax / net income | `stock_financial_facts` | Prototype | SEC / official filings | Quarterly/annual | |
| Financial raw | Basic / diluted EPS | `stock_financial_facts` | Prototype | SEC EDGAR | Quarterly/annual | Diluted EPS proof is 3 stocks |
| Financial raw | Operating / investing / financing cash flow / FCF | `stock_financial_facts` | Prototype | SEC / official filings | Quarterly/annual | |
| Financial raw | Cash / investments / assets / liabilities / debt / equity | `stock_financial_facts` | Prototype | SEC / official filings | Quarterly/annual | |
| Financial raw | Shares outstanding / weighted shares / book value per share | `stock_financial_facts` | Prototype | SEC / official filings | Quarterly/annual | |
| Financial provenance | Period, filing/publication dates, source key/document, restatement | `stock_financial_facts` | Complete schema | Provider-specific | Every write | Essential for point-in-time financial facts |
| Valuation | Historical PE | `stock_financial_facts` metric `valuation.pe` | Partial historical | TWSE/TPEx BWIBBU | Daily | 97 Taiwan stocks at snapshot |
| Valuation | Point-in-time trailing PE | `stock_financial_facts` metric `valuation.pe.ttm.point_in_time` | Prototype | SEC + Yahoo price | Daily/filing | 3 US stocks at snapshot |
| Valuation | PB / PS / PEG / market-cap history / EV | No global production series | Not started | Raw facts + formula engine | Provider / filing / daily | |
| Ratios | Dividend yield / payout | No global production series | Not started | Raw facts + corporate actions | Quarterly/daily | |
| Ratios | ROE / ROA / ROIC / margins | No global production series | Prototype | Derived from raw financial facts | Quarterly | |
| Ratios | Liquidity / leverage / turnover | No global production series | Prototype | Derived from raw financial facts | Quarterly | |
| Ratios | EV/revenue / EV/EBITDA / FCF yield | No global production series | Not started | Derived raw facts + price | Quarterly/daily | |
| Quality | Duplicate price date prevention | `stock_history` unique key | Complete | Database constraint | Every write | |
| Quality | Required close | `stock_history.close` | Complete | Database schema | Every write | |
| Quality | Failure queue / retry classification | `production_scheduler_failures` | Complete lifecycle | SmartFund lifecycle | Every run | Market job isolation |
| Quality | Missing OHLC / negative / future-date validation | Validation harness | Partial | Yahoo worker | Every run | Not proven as a global production gate |
| Quality | Currency / timezone validation | Config / diagnostics | Partial | Universe + Yahoo | Every run | Timezone is not stored on the price row |
| Quality | Split/dividend reconciliation | No global gate | Not started | Corporate-action engine | Event-driven | |
| Quality | Financial-statement / ratio cross-source validation | Prototype | SEC / official / reference providers | Filing/quarterly | Not production-wide |

## Status vocabulary

- **Complete**: canonical storage and active pipeline evidence exist.
- **Partial historical**: canonical storage plus real historical data exists, but not for the global universe.
- **Prototype**: schema or limited ingestion/derivation evidence exists; not a production-wide claim.
- **Not started**: neither canonical production data nor production pipeline evidence exists.

The machine-readable version is [global-data-dictionary.json](../config/global-data-dictionary.json).
