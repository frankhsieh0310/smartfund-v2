# Yahoo Endpoint Map — Technical Surface Inventory

## Symbol UI routes

| UI area | Route pattern | Main technical data surface |
|---|---|---|
| Summary | `/quote/{symbol}/` | Quote summary modules and chart |
| Chart | `/quote/{symbol}/chart/` | Chart JSON |
| Historical data | `/quote/{symbol}/history/` | Chart JSON / historical download route |
| Statistics | `/quote/{symbol}/key-statistics/` | `defaultKeyStatistics`, `summaryDetail`, `financialData` |
| Profile | `/quote/{symbol}/profile/` | `assetProfile`, `summaryProfile`, `quoteType` |
| Financials | `/quote/{symbol}/financials/` | Fundamentals time series |
| Analysis | `/quote/{symbol}/analysis/` | Earnings/estimate/recommendation modules |
| Options | `/quote/{symbol}/options/` | Options JSON |
| Holders | `/quote/{symbol}/holders/` | Ownership and insider modules |
| News | `/quote/{symbol}/news/` | Rendered feed surface; endpoint not captured |

## Endpoint field transport

| Endpoint | Transport | Field selection | Data shape | Historical scope |
|---|---|---|---|---|
| `v10/finance/quoteSummary/{symbol}` | JSON | `modules` list | Object keyed by module name | Module-specific; mostly current/limited history |
| `v8/finance/chart/{symbol}` | JSON | period + interval + event type | Timestamp arrays and OHLCV indicator arrays | Price/event range |
| `v7/finance/download/{symbol}` | CSV | period + interval + events | Row-oriented market data | Price/dividend/split date range |
| `ws/fundamentals-timeseries/.../{symbol}` | JSON | period + typed raw fact list | Result array by raw fact and timestamp | Annual, quarterly, trailing financials |
| `v7/finance/options/{symbol}` | JSON | expiry | Call/put chain object | Listed expiries |
| `v7/finance/quote` | JSON | symbols | Array of current quotes | Current/intraday |

## Network/XHR finding

The live AAPL and 2330.TW pages loaded successfully without a sign-in session, while
direct client requests returned their data. The browser automation environment exposes
DOM and console inspection but not a HAR/network-request stream, so “XHR” in the
coverage documents means a technically reachable HTTP JSON call verified through the
client, not a DevTools-exported request capture.

