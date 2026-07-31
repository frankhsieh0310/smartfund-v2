# Financial Statement Coverage

Snapshot: 2026-07-31. Canonical storage is `stock_financial_facts`, which supports stock, period, fiscal period, form, point-in-time filing/publication dates, source provenance, units, currency, and restatement version. It has **140,796 facts across 670 stocks and 257 metric names**. This is not yet a global statement database.

| Field | Canonical schema | Actual database coverage | Global status | Current source | Expected refresh | Next data gate |
| --- | --- | --- | --- | --- | --- | --- |
| Revenue | Yes | 571 stocks / 40,818 facts; 2007-12-31 to 2026-07-04 | Partial | SEC EDGAR | Quarterly / annual | Complete source coverage and filing-date validation |
| Cost of revenue | Yes (generic fact) | No global evidence | Prototype | SEC / official filings | Quarterly / annual | Provider mapping + field normalization |
| Gross profit | Yes (generic fact) | No global evidence | Prototype | SEC / official filings | Quarterly / annual | Same |
| Operating income / EBIT / EBITDA | Yes (generic fact) | No global evidence | Prototype | SEC / official filings | Quarterly / annual | Same |
| Pretax income / net income | Yes (generic fact) | No global evidence | Prototype | SEC / official filings | Quarterly / annual | Same |
| Basic EPS | Yes (generic fact) | No global evidence | Prototype | SEC / official filings | Quarterly / annual | Same |
| Diluted EPS | Yes | 3 stocks / 220 quarterly facts; 2007-09-30 to 2026-06-30 | Prototype | SEC EDGAR companyfacts | Quarterly / annual | Expand only after point-in-time validation |
| Cash / short-term investments | Yes (generic fact) | No global evidence | Prototype | SEC / official filings | Quarterly / annual | Field normalization |
| Accounts receivable / inventory | Yes (generic fact) | No global evidence | Prototype | SEC / official filings | Quarterly / annual | Field normalization |
| Current assets / total assets | Yes (generic fact) | No global evidence | Prototype | SEC / official filings | Quarterly / annual | Field normalization |
| Current liabilities / total liabilities | Yes (generic fact) | No global evidence | Prototype | SEC / official filings | Quarterly / annual | Field normalization |
| Long-term debt / equity | Yes (generic fact) | No global evidence | Prototype | SEC / official filings | Quarterly / annual | Field normalization |
| Operating / investing / financing cash flow | Yes (generic fact) | No global evidence | Prototype | SEC / official filings | Quarterly / annual | Field normalization |
| Free cash flow | Yes (generic fact / derived) | No global evidence | Prototype | Raw cash flow + formula | Quarterly / annual | Define point-in-time calculation policy |
| Shares outstanding / weighted shares | Yes (generic fact) | No global evidence | Prototype | SEC / official filings | Quarterly / annual | Filing-date and split-basis validation |
| Book value per share | Yes (generic fact / derived) | No global evidence | Prototype | Equity + shares / official | Quarterly / annual | Define calculation and validation policy |

## Official-provider readiness by market

| Provider | Markets in this scope | Actual production ingestion | Status |
| --- | --- | --- | --- |
| SEC EDGAR | US exchanges | Revenue partial; limited diluted-EPS proof | Partial |
| MOPS / TWSE / TPEx filings | Taiwan | No canonical financial-statement ingestion in this snapshot | Not started |
| EDINET | Japan | No ingestion | Not started |
| DART | Korea | No ingestion | Not started |
| Yahoo financial series | Cross-market | Limited experimental facts only; not a global import path | Prototype |

## Integrity policy

Financial facts may enter production only with a period end, metric normalization, source, source document/key, and unit/currency when applicable. Point-in-time metrics additionally need filing or publication availability. This report makes no claim that annual, quarterly, or daily financial coverage is complete globally.
