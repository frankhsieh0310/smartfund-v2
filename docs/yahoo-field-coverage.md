# Yahoo Field Coverage — Technical Inventory

## Field count method

Counts are static interface declarations plus live availability probes, not a claim
that every ticker returns every field.

| Inventory | Count | Basis |
|---|---:|---|
| Quote-summary technical modules | 33 | Installed module union |
| AAPL returned modules | 30 | Live `modules=all` probe |
| 2330.TW returned modules | 27 | Live `modules=all` probe |
| Quote-summary declared properties | 617 (496 unique names) | Static `quoteSummary-iface.d.ts` property inventory |
| Quote declared properties | 163 (133 unique names) | Static quote interface property inventory |
| Fundamental raw financial fields | 484 | 142 income + 285 balance + 147 cash flow, de-duplicated |
| Direct historical price/event field types | 8 | OHLCV + dividend event + split event |
| Combined technical interface-name inventory | 1,036 | De-duplicated local client declarations across quote, quote-summary and fundamentals; includes a small number of transport/meta names. |

## Field families

| Field family | Example field names | Current | Historical | JSON | Route/module |
|---|---|---:|---:|---:|---|
| Quote / price | `regularMarketPrice`, `regularMarketOpen`, `regularMarketDayHigh`, `regularMarketDayLow`, `regularMarketVolume`, `marketCap` | Yes | Intraday/price chart | Yes | `price`, `summaryDetail`, chart |
| Statistics | `trailingPE`, `forwardPE`, `priceToBook`, `bookValue`, `sharesOutstanding`, `floatShares`, `beta`, `enterpriseValue` | Yes | Only underlying raw portions where supplied | Yes | `defaultKeyStatistics` |
| Summary detail | `previousClose`, `open`, `bid`, `ask`, `dayLow`, `dayHigh`, `fiftyTwoWeekLow`, `fiftyTwoWeekHigh`, `averageVolume`, `dividendYield` | Yes | Selected price/event history | Yes | `summaryDetail`, chart |
| Financial data | `totalRevenue`, `revenuePerShare`, `grossMargins`, `operatingMargins`, `profitMargins`, `returnOnAssets`, `returnOnEquity`, `ebitda`, `freeCashflow`, `totalCash`, `totalDebt` | Yes | Raw-statement counterparts only | Yes | `financialData`, fundamentals time series |
| Income statement | `totalRevenue`, `costOfRevenue`, `grossProfit`, `operatingIncome`, `EBIT`, `EBITDA`, `netIncome`, `basicEPS`, `dilutedEPS` | Yes | Yes | Yes | Fundamentals time series |
| Balance sheet | `cashAndCashEquivalents`, `inventory`, `totalAssets`, `currentLiabilities`, `totalDebt`, `stockholdersEquity`, `ordinarySharesNumber` | Yes | Yes | Yes | Fundamentals time series |
| Cash flow | `operatingCashFlow`, `freeCashFlow`, `capitalExpenditure`, `investingCashFlow`, `financingCashFlow`, `cashDividendsPaid` | Yes | Yes | Yes | Fundamentals time series |
| Earnings / estimates | `earningsAverage`, `earningsLow`, `earningsHigh`, `revenueAverage`, `epsTrend`, `growth`, `recommendationMean`, `targetMeanPrice` | Yes | Limited recent / forward | Yes | Earnings/analysis modules |
| Ownership / insider | `heldPercentInsiders`, `heldPercentInstitutions`, holder records, transaction records | Yes | Snapshot/report/event partial | Yes | Holder/insider modules |
| Profile | `longBusinessSummary`, `website`, `industry`, `sector`, `fullTimeEmployees`, officers | Yes | No | Yes | Profile modules |
| Events / actions | earnings dates, `exDividendDate`, `dividendDate`, dividend events, split events | Yes | Yes for dividends/splits | Yes | Calendar + chart events |
| Options | expiration dates, calls, puts, strikes, implied volatility, Greeks where supplied | Yes | Per expiration chain | Yes | Options endpoint |
| Sustainability | ESG score fields | Not observed | Not observed | Not observed | No current module observed |
| News | title, publisher, link, publish time, article metadata | Yes | Feed timestamps | Rendered page observed | Symbol news route |

## Explicit field-status examples

| Field | Current | Historical | API/JSON | AAPL | 2330.TW |
|---|---:|---:|---:|---:|---:|
| `trailingPE` | Yes | No complete series | Yes | Yes | Yes |
| `forwardPE` | Yes | No complete series | Yes | Yes | Yes |
| `priceToBook` | Yes | No complete series | Yes | Yes | Yes |
| `marketCap` | Yes | No complete series | Yes | Yes | Yes |
| `sharesOutstanding` | Yes | Filing-period raw shares partial | Yes | Yes | Yes |
| `totalRevenue` | Yes | Annual/quarterly/TTM | Yes | Yes | Yes |
| `grossProfit` | Yes | Annual/quarterly/TTM | Yes | Yes | Yes |
| `netIncome` | Yes | Annual/quarterly/TTM | Yes | Yes | Yes |
| `dilutedEPS` | Yes | Annual/quarterly/TTM | Yes | Yes | Yes |
| `freeCashFlow` | Yes | Annual/quarterly/TTM | Yes | Yes | Yes |
| `bookValue` | Yes | Equity raw facts historical | Yes | Yes | Yes |
| `returnOnEquity` | Yes | No complete direct series | Yes | Yes | Yes |
| `returnOnAssets` | Yes | No complete direct series | Yes | Yes | Yes |
| `dividendRate` / dividend event | Yes | Event history | Yes | Yes | Yes |
| `institutionOwnership` | Yes | Snapshot/report partial | Yes | Yes | Yes |
| `upgradeDowngradeHistory` | Yes | Event records | Yes | Yes | No |
