# Yahoo Historical Coverage — Field-Level Technical Matrix

The table separates a **historical series** from a current value labelled TTM,
forward or “5Y”. A current trailing figure is not counted as historical unless Yahoo
returns dated observations.

| Field / field group | Current | Historical | Observed earliest | Frequency | AAPL | 2330.TW | Technical source |
|---|---:|---:|---|---|---:|---:|---|
| Open | Yes | Yes | Symbol-specific chart; AAPL chart has 6,682 rows | Daily/intraday | Yes | Yes | Chart |
| High | Yes | Yes | Same chart range | Daily/intraday | Yes | Yes | Chart |
| Low | Yes | Yes | Same chart range | Daily/intraday | Yes | Yes | Chart |
| Close | Yes | Yes | Same chart range | Daily/intraday | Yes | Yes | Chart |
| Adjusted close | Yes | Yes | Same chart range | Daily | Yes | Yes | Chart |
| Volume | Yes | Yes | Same chart range | Daily/intraday | Yes | Yes | Chart |
| Dividend event | Yes | Yes | Symbol-specific; AAPL 56, 2330.TW 44 events | Event driven | Yes | Yes | Chart events |
| Split event | Yes | Yes | Symbol-specific; AAPL 4, 2330.TW 10 events | Event driven | Yes | Yes | Chart events |
| Total revenue | Yes | Yes | AAPL 2021 annual; 2330.TW 2021 annual | Annual/quarterly/TTM | Yes | Yes | Fundamentals time series |
| Gross profit | Yes | Yes | Same statement depth | Annual/quarterly/TTM | Yes | Yes | Fundamentals time series |
| Operating income | Yes | Yes | Same statement depth | Annual/quarterly/TTM | Yes | Yes | Fundamentals time series |
| EBIT / EBITDA | Yes | Yes | Same statement depth where supplied | Annual/quarterly/TTM | Yes | Yes | Fundamentals time series |
| Net income | Yes | Yes | Same statement depth | Annual/quarterly/TTM | Yes | Yes | Fundamentals time series |
| Basic / diluted EPS | Yes | Yes | Same statement depth | Annual/quarterly/TTM | Yes | Yes | Fundamentals time series |
| Basic / diluted weighted shares | Yes | Yes | Same statement depth | Annual/quarterly/TTM | Yes | Yes | Fundamentals time series |
| Cash / investments / receivables / inventory | Yes | Yes | Same statement depth where supplied | Annual/quarterly/TTM | Yes | Yes | Fundamentals time series |
| Assets / liabilities / debt / equity / book value | Yes | Yes | Same statement depth where supplied | Annual/quarterly/TTM | Yes | Yes | Fundamentals time series |
| Operating cash flow / FCF / capex | Yes | Yes | Same statement depth where supplied | Annual/quarterly/TTM | Yes | Yes | Fundamentals time series |
| PE / trailing PE / forward PE | Yes | No complete dated series observed | N/A | Current/TTM/forward | Yes | Yes | Statistics / summary |
| PB / price to book | Yes | No complete dated series observed | N/A | Current | Yes | Yes | Statistics |
| PS / price to sales | Yes | No complete dated series observed | N/A | Current | Yes | Yes | Statistics |
| Enterprise value / EV ratios | Yes | No complete dated series observed | N/A | Current | Yes | Yes | Statistics |
| Gross / operating / net margin | Yes | No complete dated series observed | N/A | Current/TTM | Yes | Yes | Financial data |
| ROE / ROA / ROIC | Yes (ROE/ROA where returned) | No complete dated series observed | N/A | Current/TTM | Yes | Yes | Financial data |
| Market cap | Yes | No complete dated series observed | N/A | Current/intraday | Yes | Yes | Price/statistics |
| Shares outstanding | Yes | Partial: reporting-period shares | Statement period | Current + filing period | Yes | Yes | Statistics + fundamentals |
| Earnings actual / surprise | Yes | Limited recent records | Module-dependent | Quarterly/event | Yes | Yes | Earnings history |
| Revenue/EPS estimate | Yes | Forward/current; not a complete revision series | N/A | Provider updates | Yes | Yes | Earnings trend |
| Recommendation / target | Yes | Limited recommendation/action records | Module-dependent | Provider updates | Yes | Yes | Recommendation / upgrades |
| Institutional / fund ownership | Yes | Snapshot/report records; no complete series observed | Module-dependent | Filing/report | Yes | Yes | Ownership modules |
| Insider transactions | Yes | Transaction records where supplied | Module-dependent | Event | Yes | No | Insider modules |
| Sustainability / ESG | Not observed | Not observed | N/A | N/A | No | No | No current module observed |

## Financial raw-field field coverage

`fundamentalsTimeSeries` declares **484 distinct raw field names** after de-duplication:

| Group | Declared field count | Historical form |
|---|---:|---|
| Income statement | 142 | Annual, quarterly, trailing |
| Balance sheet | 285 | Annual, quarterly, trailing |
| Cash flow | 147 | Annual, quarterly, trailing |
| De-duplicated raw fact names | 484 | Symbol-specific availability |

The full candidate-field names are in the installed technical type declaration
`node_modules/yahoo-finance2/esm/src/modules/fundamentalsTimeSeries.d.ts`; the endpoint
omits fields that have no reported value for the requested symbol/period.

