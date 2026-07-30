# Yahoo Historical Financial Complete Audit

**Audit date:** 2026-07-30
**Scope:** Yahoo Finance website surfaces and the endpoints currently exercised by the
repository. This is a capability and provenance audit; it does **not** authorize a
new downloader, ingestion run, or use of Yahoo data beyond its terms.

## Decision summary

Yahoo is a useful **technical reference and candidate provider**, but it is **not
currently approved as a SmartFund production financial-data provider**. The
distinction matters:

| Dimension | Result |
|---|---|
| Can the data be read technically? | Yes, for price/events and many raw statement facts. |
| Does Yahoo publish an official bulk financial-data API for this use? | No evidence found. |
| Can SmartFund bulk-import, permanently store, and serve it commercially under the public terms? | **No — written Yahoo/data-provider permission is required.** |
| Can historical financial statements replace an official filing archive? | No. Depth, coverage, restatements, and availability vary by symbol. |

Yahoo's own coverage page identifies the underlying providers: Morningstar provides
financial statements, valuation ratios, market cap and shares outstanding; S&P Global
Market Intelligence provides EPS/revenue estimates and actuals; Vickers provides top
institutional and mutual-fund holders. Yahoo also says not to redistribute information
displayed on or provided by Yahoo Finance. The Yahoo Terms prohibit automated collection
without prior permission and commercial reproduction/distribution without explicit
written permission. Therefore every `direct import` result below has two values:

- **Technical:** whether the observed Yahoo surface/endpoint supplies a normalized
  value suitable for an adapter prototype.
- **Production-authorised:** whether public Yahoo terms grant SmartFund permission to
  bulk ingest, persist and serve it. This is `NO` for every Yahoo category until a
  written commercial licence is recorded.

## Evidence and reproducible probes

### Local adapter contract

The repository's installed `yahoo-finance2` package exposes the following Yahoo
surfaces:

- `chart`: historical OHLCV plus dividend and split events.
- `fundamentalsTimeSeries`: `annual`, `quarterly`, and `trailing` income statement,
  balance sheet, and cash-flow values.
- `quoteSummary`: current statistics plus limited earnings, ownership, estimate and
  recommendation modules.

The package describes the statement endpoint as symbol-dependent and typically about
five or more years for large-cap companies. It explicitly advises use of
`fundamentalsTimeSeries` because the older quote-summary financial-history modules
have provided almost no data since November 2024.

Read-only probes on 2026-07-30 confirmed the following representative results:

| Symbol | Annual statement coverage | Quarterly statement coverage | Chart rows | Dividend events | Split events |
|---|---|---|---:|---:|---:|
| AAPL | 5 annual periods, 2021-09-30–2025-09-30 | 5–6 recent quarters, depending on statement | 6,682 | 56 | 4 |
| 2330.TW | 5 annual periods, 2021-12-31–2025-12-31 | 5–7 recent quarters, depending on statement | 6,613 | 44 | 10 |

These are **observations, not service guarantees**. The Taiwan trailing requests also
exposed parser-schema drift in the installed client, which is another reason a
production financial pipeline must have a raw-response contract test and cannot assume
uniform Yahoo coverage.

### Field inventory basis

The installed endpoint type declarations contain 142 income-statement fields, 285
balance-sheet fields and 147 cash-flow fields. After de-duplicating fields shared by
multiple statements, this is **484 distinct raw financial-statement field names**.
They are candidate fields only: every symbol/period can omit facts.

## Complete field-family audit

`Earliest` is intentionally reported as **symbol-specific**, rather than a made-up
global year. For the actual financial-statement probe the earliest observed annual
period was 2021. Historical chart data can extend much farther (Yahoo Help says prices
usually do not go earlier than 1970). `Frequency` means the natural provider update
cadence, not a SmartFund schedule.

| Field family / individual fields | Exists on Yahoo | Historical series | Earliest / frequency | CSV export | Programmatic | Bulk | Premium requirement | Direct import (technical / production-authorised) | Required action |
|---|---|---|---|---|---|---|---|---|---|
| Open, High, Low, Close, Adjusted Close, Volume | Yes | Yes, chart time series | Per symbol; usually no earlier than 1970 / trading day | Gold for Yahoo's UI CSV download | Yes, observed chart endpoint | No official bulk interface | Gold for UI download | Yes / No | Keep price adapter separate; commercial permission required. |
| Cash dividend event; split event | Yes | Yes, chart events | Per symbol / event driven | Gold UI CSV for historical download | Yes, observed chart endpoint | No official bulk interface | Gold for UI download | Yes / No | Direct event normalization only after licensing. |
| Income statement raw facts: revenue, cost of revenue, gross profit, operating expense, operating income, EBIT, EBITDA, interest, tax, net income, R&D, SG&A, EPS, weighted-average shares, unusual items and sector-specific lines | Yes | Yes, annual / quarterly / TTM | Symbol-specific; observed 5 annual periods / quarterly after each filing, TTM quarterly | No documented financial-statement CSV export | Yes, observed `fundamentalsTimeSeries` endpoint | No official bulk interface | No public requirement for viewing; no documented bulk licence | Yes / No | Prefer Yahoo raw facts only if licensed; otherwise use filing source. |
| Balance sheet raw facts: cash, investments, receivables, inventory, PPE, goodwill, intangible assets, current/non-current assets, debt, payables, leases, deferred tax, equity, retained earnings, ordinary/preferred/treasury shares | Yes | Yes, annual / quarterly / TTM where supplied | Symbol-specific; observed 5 annual periods / quarterly after filing | No documented CSV export | Yes, observed `fundamentalsTimeSeries` endpoint | No official bulk interface | No documented bulk licence | Yes / No | Direct raw import candidate, not a complete archive. |
| Cash-flow raw facts: operating, investing and financing cash flow, FCF, capex, D&A, working-capital changes, debt/share flows, dividends paid, taxes and interest | Yes | Yes, annual / quarterly / TTM where supplied | Symbol-specific; observed 5 annual periods / quarterly after filing | No documented CSV export | Yes, observed `fundamentalsTimeSeries` endpoint | No official bulk interface | No documented bulk licence | Yes / No | Direct raw import candidate, not a complete archive. |
| Dividend per share; cash dividends paid | Yes | Yes, statement series; event history for distributions | Symbol-specific / quarterly, annual, event driven | No statement CSV; historical-event UI CSV is Gold | Yes | No official bulk interface | Gold for event CSV; no bulk licence | Yes / No | Use event series for distribution history; reconcile to cash-flow fact. |
| Shares outstanding / ordinary shares / issued shares / treasury shares / diluted and basic average shares | Yes | **Partial**: annual/quarterly statement facts; no verified daily full share-count series | Symbol-specific / filing cadence | No documented statement CSV | Yes for raw filing-period facts | No official bulk interface | No documented bulk licence | Partial / No | Direct filing-period facts; rebuild daily market-cap inputs only if a licensed share series exists. |
| Market cap | Yes | No verified historical market-cap time series | Current snapshot / market day | No documented historical CSV | Current quote/statistics only verified | No official bulk interface | No documented bulk licence | Current only / No | Rebuild historical market cap from close × point-in-time shares. |
| Book value / stockholders' equity / tangible book value | Yes | Yes as raw balance-sheet facts | Symbol-specific / annual, quarterly, TTM where supplied | No documented CSV | Yes | No official bulk interface | No documented bulk licence | Yes (raw) / No | Rebuild book value per share and historical PB from raw facts plus shares/price. |
| Revenue, operating revenue, gross profit, operating income, net income | Yes | Yes as raw statement series | Symbol-specific / annual, quarterly, TTM | No documented CSV | Yes | No official bulk interface | No documented bulk licence | Yes / No | Direct raw import; derive margins/growth. |
| Basic EPS, diluted EPS, normalized EPS | Yes | Yes as raw statement series | Symbol-specific / annual, quarterly, TTM | No documented CSV | Yes | No official bulk interface | No documented bulk licence | Yes / No | Direct raw import; derive historical PE where period alignment is explicit. |
| Free cash flow, operating cash flow, capex | Yes | Yes as raw cash-flow series | Symbol-specific / annual, quarterly, TTM | No documented CSV | Yes | No official bulk interface | No documented bulk licence | Yes / No | Direct raw import; derive FCF yield/margins. |
| PE, forward PE, PB, PS, PEG, EV/EBITDA, EV/sales, dividend yield, profit/operating/gross margins, ROE, ROA, debt/equity, current ratio, quick ratio | Yes as quote/statistics values | **No verified complete point-in-time historical ratio series** | Current/near-current snapshot; selected forward/TTM values change with market/filing updates | No documented ratio-history CSV | Current quote-summary/statistics technically readable | No official bulk interface | No documented bulk licence | Current only / No | Rebuild from licensed raw facts and price; preserve calculation version and point-in-time dates. |
| Enterprise value | Yes as current statistic | No verified historical series | Current snapshot / market day | No documented CSV | Current statistics technically readable | No official bulk interface | No documented bulk licence | Current only / No | Rebuild from market cap, debt and cash. |
| Earnings actuals, earnings dates, surprise history | Yes | **Limited** historical module, not a complete long-term series | Recent earnings periods / event driven | No documented CSV | `earnings`, `earningsHistory`, `calendarEvents` modules | No official bulk interface | No documented bulk licence | Partial / No | Use as a calendar/validation surface; filing source needed for long-term history. |
| Revenue/EPS estimates, target price, recommendation trend, upgrade/downgrade history | Yes | Forward and limited recent trend/history, **not** a complete historical revision series | Future/current and limited recent history / provider changes | No documented CSV | Quote-summary modules | No official bulk interface | No documented bulk licence | Partial / No | Need a licensed estimate-history provider for revision history. |
| Major holders, institutional holders, mutual-fund holders | Yes | Current/snapshot records with report dates; no verified complete ownership time series | Filing/report cadence | No documented CSV | Quote-summary ownership modules | No official bulk interface | No documented bulk licence | Snapshot only / No | Need a licensed ownership-history provider or filing-derived reconstruction. |
| Insider holders, insider transactions, net share purchase activity | Yes | Transaction/snapshot surface; no verified all-period coverage | Event/report cadence | No documented CSV | Quote-summary modules | No official bulk interface | No documented bulk licence | Partial / No | Treat as limited event data; use official filing source for durable history. |
| Corporate actions beyond dividends/splits: merger, spin-off, rights issue, symbol change, delisting | Partial | No general verified historical event series | Event driven | No documented CSV | Some quote/calendar metadata only | No official bulk interface | No documented bulk licence | Partial / No | Need exchange/company-action source. |

## Raw statement field catalogue

Yahoo's programmatic statement surface is not a small set of ratios. It declares **484
distinct normalized raw fact names** across three categories. The complete declaration
is held in `node_modules/yahoo-finance2/esm/src/modules/fundamentalsTimeSeries.d.ts`;
the groups below are the import contract SmartFund should map rather than recalculating
or collapsing source facts prematurely.

| Raw group | Declared fields | Examples that must remain raw |
|---|---:|---|
| Income statement | 142 | `totalRevenue`, `costOfRevenue`, `grossProfit`, `operatingIncome`, `EBIT`, `EBITDA`, `taxProvision`, `netIncome`, `basicEPS`, `dilutedEPS`, `basicAverageShares`, `dilutedAverageShares`, `researchAndDevelopment`, `sellingGeneralAndAdministration`, interest, unusual-item, banking and insurance lines. |
| Balance sheet | 285 | `cashAndCashEquivalents`, `otherShortTermInvestments`, `accountsReceivable`, `inventory`, `netPPE`, `goodwill`, `totalAssets`, `currentLiabilities`, `longTermDebt`, `totalDebt`, `stockholdersEquity`, `retainedEarnings`, `ordinarySharesNumber`, `shareIssued`, `treasurySharesNumber`, deferred tax, lease, deposit and sector-specific lines. |
| Cash flow | 147 | `operatingCashFlow`, `freeCashFlow`, `capitalExpenditure`, `investingCashFlow`, `financingCashFlow`, `cashDividendsPaid`, `repurchaseOfCapitalStock`, `issuanceOfDebt`, `repaymentOfDebt`, `depreciationAndAmortization`, working-capital and sector-specific lines. |
| **De-duplicated total** | **484** | A value can be absent for a company even though the interface declares its name. |

## Import policy produced by this audit

1. **Do not build a Yahoo financial ingestion job yet.** It would be technically
   feasible, but no public Yahoo term found grants the required automated,
   commercial, persistent and redistributable use.
2. If written permission is obtained, import only raw period facts from
   `fundamentalsTimeSeries`, with the source period end, period type, currency,
   source key and observed/imported timestamps. Do not substitute them with derived
   ratios.
3. Use Yahoo chart dividend/split events directly only under the same licensed
   provider agreement.
4. Rebuild (or obtain separately) historical market cap, valuation ratios, margin
   ratios, ROE/ROA/ROIC, ownership history and analyst-revision history. Yahoo's
   public surface is current, partial, or non-series for those categories.
5. Do not treat the installed third-party client as an official Yahoo API or a
   production licence. It is evidence of technical reachability only.

## Sources

- [Yahoo Finance: exchanges and data providers](https://help.yahoo.com/kb/finance/SLN2310.html)
- [Yahoo Finance: download historical data](https://help.yahoo.com/kb/finance/certain-amounts-sln2311.html)
- [Yahoo Terms of Service](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html)
- [Yahoo API terms](https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apitnc/index.html)
