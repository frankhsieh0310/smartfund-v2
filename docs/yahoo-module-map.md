# Yahoo Finance Module Map — Technical Reverse Engineering

**Scope:** technical availability only, probed 2026-07-30 with `AAPL` and
`2330.TW`.

## Coverage key

- **Observed:** returned by the live probe or visible in the live symbol page.
- **Partial:** the module existed but fields differed by symbol or were incomplete.
- **Not observed:** no result for that symbol/route in this audit; this does not prove
  Yahoo never supplies it.
- **Historical:** repeatable dated observations, not merely a current field containing
  a trailing value.

## Symbol-page modules

| Yahoo area | Visible symbol route | Technical module / surface | AAPL | 2330.TW | Historical form | Notes |
|---|---|---|---|---|---|---|
| Summary | `/quote/{symbol}/` | `price`, `summaryDetail`, `financialData`, `defaultKeyStatistics`, `summaryProfile` | Observed | Observed | Mostly current | Current quote, ranges, volume, statistics, profile and selected trailing values. |
| Chart | `/quote/{symbol}/chart/` or advanced chart | chart JSON | Observed | Observed | Yes | Intraday through all-range OHLCV, indicators, dividends and splits where supplied. |
| Historical Data | `/quote/{symbol}/history/` | chart JSON; download route | Observed navigation | Observed navigation | Yes | Date-range/frequency UI; chart JSON returned 6,682 AAPL and 6,613 2330.TW observations. |
| Statistics / Key Statistics | `/quote/{symbol}/key-statistics/` | `defaultKeyStatistics`, `summaryDetail`, `financialData` | Observed | Observed | Current / selected TTM | Current market cap, trailing/forward ratios, shares, short interest, book value, beta and margins where present. |
| Profile | `/quote/{symbol}/profile/` | `assetProfile`, `summaryProfile`, `quoteType` | Observed | Observed | Current | Address, sector, industry, officers, description, employees, web site and identifiers. |
| Financials | `/quote/{symbol}/financials/` | `fundamentalsTimeSeries`; legacy quote-summary statement modules | Observed | Observed | Annual, quarterly, TTM | Income statement, balance sheet and cash flow. Use `fundamentalsTimeSeries` for actual statement periods. |
| Analysis | `/quote/{symbol}/analysis/` | `earnings`, `earningsHistory`, `earningsTrend`, `recommendationTrend`, `upgradeDowngradeHistory` | Observed | Partial | Recent history and forward/current | AAPL returns all five technical modules; 2330.TW lacks `upgradeDowngradeHistory`. |
| Earnings | Summary / Analysis / calendar | `calendarEvents`, `earnings`, `earningsHistory`, `earningsTrend` | Observed | Observed | Partial | Dates, actual/estimate fields and recent surprise/trend records. |
| Holders | `/quote/{symbol}/holders/` | `majorHoldersBreakdown`, `majorDirectHolders`, `institutionOwnership`, `fundOwnership` | Observed | Observed | Snapshot/report dated | A historical filing-by-filing series was not observed. |
| Insider | Summary / holders surfaces | `insiderHolders`, `insiderTransactions`, `netSharePurchaseActivity` | Observed | Partial | Transactions/snapshot | `insiderTransactions` returned for AAPL, not for 2330.TW. |
| Options | `/quote/{symbol}/options/` | options JSON | Route available | Route available | Expiry chain | Not expanded in this financial-field audit; separate options chain, calls and puts surface exists. |
| Sustainability / ESG | legacy sustainability surface | No current quote-summary module observed | Not observed | Not observed | Not observed | No live ESG payload was confirmed by the installed client or the two symbol probes. |
| News | `/quote/{symbol}/news/` | rendered symbol news surface | Observed | Observed | Article/feed timestamps | Present on both summary pages; item feed endpoint was not captured in this audit. |
| Events | calendar / summary | `calendarEvents`; chart dividends/splits | Observed | Observed | Earnings/dividend dates; dividends/splits | Merger, spin-off and rights event series were not observed. |
| Corporate actions | chart / statistics | chart `events.dividends`, `events.splits`; latest split fields | Observed | Observed | Dividend/split event series | Other action types not observed. |

## `quoteSummary` technical module map

The installed client declares **33 modules**. AAPL returned **30 non-null modules**;
2330.TW returned **27**. Availability is symbol-dependent.

| Module | Field families | AAPL | 2330.TW | Historical / current |
|---|---|---:|---:|---|
| `assetProfile` | company address, industry, sector, officers, risks | Yes | Yes | Current |
| `balanceSheetHistory` | legacy annual balance sheet container | Yes | Yes | Historical but sparse |
| `balanceSheetHistoryQuarterly` | legacy quarterly balance sheet container | Yes | Yes | Historical but sparse |
| `calendarEvents` | earnings, ex-dividend, dividend dates | Yes | Yes | Event / upcoming / recent |
| `cashflowStatementHistory` | legacy annual cash flow container | Yes | Yes | Historical but sparse |
| `cashflowStatementHistoryQuarterly` | legacy quarterly cash flow container | Yes | Yes | Historical but sparse |
| `defaultKeyStatistics` | valuation, shares, short interest, book value, beta | Yes | Yes | Current / TTM |
| `earnings` | annual and quarterly earnings summary | Yes | Yes | Historical aggregates |
| `earningsHistory` | earnings actual/estimate/surprise records | Yes | Yes | Limited recent |
| `earningsTrend` | current and forward estimates | Yes | Yes | Forward / current |
| `financialData` | current margins, returns, revenue, EBITDA, debt/cash | Yes | Yes | Current / TTM |
| `fundOwnership` | fund-holder records | Yes | Yes | Snapshot/report dated |
| `fundPerformance` | fund-only data | No | No | Instrument-specific |
| `fundProfile` | fund-only metadata | No | No | Instrument-specific |
| `incomeStatementHistory` | legacy annual income statement container | Yes | Yes | Historical but sparse |
| `incomeStatementHistoryQuarterly` | legacy quarterly income statement container | Yes | Yes | Historical but sparse |
| `indexTrend` | index trend metadata | Yes | Yes | Current / comparison |
| `industryTrend` | industry trend metadata | Yes | Yes | Current / comparison |
| `insiderHolders` | insider-holder records | Yes | Yes | Snapshot/report dated |
| `insiderTransactions` | insider transaction records | Yes | No | Transaction history |
| `institutionOwnership` | institutional-holder records | Yes | Yes | Snapshot/report dated |
| `majorDirectHolders` | major direct holder records | Yes | Yes | Snapshot |
| `majorHoldersBreakdown` | ownership percentages | Yes | Yes | Current / snapshot |
| `netSharePurchaseActivity` | insider share purchase aggregate | Yes | Yes | Recent / aggregate |
| `price` | real-time/delayed quote, market cap, exchange, currency | Yes | Yes | Current / intraday |
| `quoteType` | instrument identity | Yes | Yes | Current |
| `recommendationTrend` | recommendation counts | Yes | Yes | Current/recent periods |
| `secFilings` | SEC filing references | Yes | No | Filing/event history |
| `sectorTrend` | sector trend metadata | Yes | Yes | Current / comparison |
| `summaryDetail` | price statistics, ranges, volumes, dividends | Yes | Yes | Current / trailing |
| `summaryProfile` | company summary, employees, sector/industry | Yes | Yes | Current |
| `topHoldings` | fund/ETF holdings | No | No | Instrument-specific |
| `upgradeDowngradeHistory` | analyst action records | Yes | No | Event history |

## Authentication and Premium observation

| Surface | Anonymous technical probe | Login observed as required | Premium observed as required | Notes |
|---|---:|---:|---:|---|
| Summary / quote-summary | Yes | No | No | Both symbols returned detailed modules without login. |
| Chart / historical JSON | Yes | No | No | Both symbols returned chart arrays and events. |
| Fundamentals time series | Yes | No | No | Both symbols returned annual/quarterly statement observations. |
| Historical CSV download | Not executed | Not determined by probe | Gold UI promotion visible | UI download requires a separate browser download test. |
| Advanced chart / AlphaSpace | Basic chart visible | No for basic chart | Gold promotion visible | Premium-only features were not authenticated or exercised. |
| Portfolio / Follow / alerts | Not tested | Likely account-bound | Not determined | Outside public symbol-data payload scope. |
