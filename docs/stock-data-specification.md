# SmartFund Stock Data Specification v1.0

> **Final specification.** This document and
> [`config/stock-data-specification.json`](../config/stock-data-specification.json)
> are the stable contract for SmartFund stock data. Database, crawlers,
> Provider Adapters, APIs and frontend views must conform to it. This version
> creates **no** database change, API, worker or frontend feature.

## Permanent product rule

Yahoo Finance stock quote surfaces are SmartFund's minimum stock-data scope for
Yahoo-listed equities (for example `2330.TW`, `AAPL`, `MSFT`, `NVDA`).
SmartFund can add deterministic data products, but cannot claim a Yahoo field
as complete until its canonical storage, provenance, lifecycle validation and
production API exist.

### Permanent exclusion

**News, articles, commentary, video, live streams, forum, community, comments,
chat and every social-content derivative are excluded forever.** SmartFund must
not fetch, archive, quote, republish, analyse, score or expose them.

## Stable data-domain design

Future schema work must use these canonical, versioned domains rather than add
one-off columns for every metric:

`market_bar`, `quote_snapshot`, `issuer_profile`, `financial_statement`,
`financial_metric`, `corporate_event`, `calendar_event`, `ownership_snapshot`,
`ownership_change`, `analyst_estimate`, `analyst_revision`, `derived_metric`,
`performance_return`, `drawdown_metric`, `correlation_metric`,
`factor_exposure`, `peer_ranking`, `rule_insight`.

Every record requires instrument identity, provider, source symbol, provider
method, as-of date, effective date where applicable, imported/updated time,
period type and a calculation version for derived data. This keeps the schema
stable for at least the next three years while permitting new metrics.

## Source and freshness policy

| Domain | Provider | Adapter state | Refresh / freshness rule |
| --- | --- | --- | --- |
| Market prices | Yahoo | `YAHOO_CHART` registered | `period=max` for first Historical; then incremental to **Provider Latest Available** |
| Quote/profile/statistics/financials/holders | Yahoo | `YAHOO_QUOTE_SUMMARY` required | Change detection or provider publication cadence |
| Dividends/corporate actions/events | Yahoo minimum | `YAHOO_CORPORATE_ACTIONS` required | Announcement, effective-date and revision checks |
| Technicals, returns, risk, factors, rankings, scores, insights | SmartFund | deterministic calculation adapter required | Recalculate after validated inputs change |
| ESG/analyst/options | Yahoo only if permitted | licence review required | Provider Latest Available; no use before legal/provider approval |

“Latest” always means the provider's latest valid available observation—not the
calendar date. Financial, ownership, ESG, analyst and event data follow release
or report cadence, not a fabricated daily update.

## v1.0 coverage matrix

Each row defines Database, Provider, API, Frontend, Priority, Status, Required
or Optional, expected refresh and freshness policy for **every field named in
the Field scope column**. The JSON file is the exact machine-readable field
inventory.

| Data domain / field scope | Yahoo availability | Database | Provider | API / Frontend | Priority | Required | Status | Expected refresh / freshness |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Price:** Open, High, Low, Close, Adjusted Close, Volume, intraday, historical daily/weekly/monthly | Yes | `Stock` / `StockHistory` partial | Yahoo Chart | Existing partial APIs | P0 | Yes | Partial | Intraday when published; daily to Provider Latest Available |
| **Quote statistics:** average volume, turnover, VWAP, market cap, EV, 52W high/low, range, bid/ask, shares, float | Conditional | `quote_snapshot` required | Yahoo quote summary; deterministic VWAP/turnover | Not built | P1 | Yes | Not built | Quote/EOD snapshot; Provider Latest Available |
| **Technical:** SMA, EMA, MACD, RSI, KD, ATR, ADX, CCI, Williams %R, ROC, Momentum, OBV, VWAP, Bollinger, Beta, historical volatility, MA distance, trend/support/resistance/breakout/gap | Yes / derived | `StockTechnical` partial; `derived_metric` required | SmartFund from Yahoo OHLCV | Not built | P1 | Yes | Partial | Recalculate after accepted bar |
| **Profile:** identity, sector/industry/GICS, description, site, employees, IPO, CEO/executives, fiscal year | Conditional | `Stock` partial; `issuer_profile` required | Yahoo quote summary | Existing partial API | P1 | Yes | Partial | Change detection / filing-event refresh |
| **Statements:** Income Statement, Balance Sheet, Cash Flow; annual, quarterly, TTM and named lines | Conditional | `financial_statement` required | Yahoo quote summary | Not built | P1 | Yes | Not built | Filing/publication cadence |
| **Ratios:** PE, Forward PE, PEG, PB, PS, yield, ROE/ROA/ROIC, margins, leverage/liquidity, growth, FCF, EV multiples, payout | Conditional / derived | `financial_metric` required | Yahoo quote summary + deterministic calculation | Not built | P1 | Yes | Not built | Quote and statement cadence |
| **Dividends / actions:** history, ex-date, payment, split/reverse split, rights, symbol change, merger, spin-off, delisting | Partial / conditional | `corporate_event` required | Yahoo corporate actions; official supplement where Yahoo is incomplete | Not built | P1 | Yes | Not built | Event publication/effective-date checks |
| **Event Calendar:** dividends, ex-div, splits, rights, earnings, calls, shareholder meetings, ETF rebalance, MSCI/FTSE/S&P changes, timeline | Partial / conditional | `calendar_event` required | Yahoo + approved issuer/exchange/index calendars | Not built | **P1.5** | Yes | Not built | Daily due-event/revision check |
| **Ownership Change:** holders, institutions, funds/ETFs, insiders, short interest plus previous %, current %, change %, quarter | Conditional | `ownership_snapshot`, `ownership_change` required | Yahoo holders; official filing fallback for full coverage | Not built | **P1.5** | Yes | Not built | Report/publication cadence |
| **Estimate Revision:** targets, consensus, EPS/revenue estimates and revisions, upgrades/downgrades, 30/90/180-day windows, earnings/surprise | Conditional / licensed | `analyst_estimate`, `analyst_revision` required | Yahoo analysis only after licence review | Not built | **P1.5** | Yes | Not built | Provider revision cadence |
| **Valuation History:** PE/PB/PS/EV-EBITDA history, percentile, 5Y/10Y averages | Derived from Yahoo inputs | `financial_metric` snapshots required | SmartFund calculation | Not built | **P1.5** | Yes | Not built | After validated quote/statement change |
| **Risk / Total Return / Drawdown:** volatility, Sharpe, Sortino, beta, tracking error, information ratio, price/dividend/total return windows, drawdowns, recovery days | Derived from Yahoo inputs | return/drawdown/derived domains required | SmartFund calculation | Not built | **P1.5** | Yes | Not built | After validated daily bar/event |
| **Correlation / Factor / Peer:** correlations to S&P 500, NASDAQ, 0050, gold, BTC, bonds; factor exposures; industry and metric rankings | Derived from declared inputs | correlation/factor/ranking domains required | SmartFund calculation | Not built | **P1.5** | Yes | Not built | After bar, fundamental or peer-universe change |
| **ESG:** ESG/E/S/G, controversy, percentile, Yahoo sustainability fields | Conditional / licensed | Required | Yahoo only after licence review | Not built | P2 | Optional | Not built | Provider release cadence |
| **Options:** expiry, calls/puts, strike, prices, volume, OI, IV, ITM, contract | Conditional / licensed | Required | Yahoo only after licence review | Not built | P3 | Optional | Not built | Provider quote cadence |
| **SmartFund scores & rule insights:** AI/quality/growth/value/momentum/risk/composite/SmartMatch; explainable valuation, peer, dividend, growth, revision and drawdown insights | SmartFund only | derived/insight domains required | Deterministic rules/calculations | Not built | P2 | Optional | Not built | After valid dependent input changes |

## P1.5 definition

P1.5 is not a cosmetic enhancement. It creates the time-aware layer needed for
serious research and SmartMatch: timelines, ownership changes, forecast
vintages, valuation percentiles, risk/return histories, benchmark correlations,
factor exposures and peer-relative rankings. All P1.5 data must retain its
source/as-of date and calculation or peer-universe version.

## Priority and implementation phases

1. **P0 — Foundation:** price, Historical provenance and Production Daily.
2. **P1 — Issuer Core:** fundamentals, statements, ratios, actions and complete
   deterministic technical lifecycle.
3. **P1.5 — Market Intelligence:** event timeline, ownership change, revisions,
   valuation history, risk/return/drawdown, correlation/factors/peers.
4. **P2 — Enrichment:** holders, ESG and analyst data after licence review,
   then SmartFund scores and rule insights.
5. **P3 — Derivative Extension:** options.
6. **Excluded:** all editorial, media and social/community content.

## Acceptance rule

A field is complete only when its required domain, Provider Adapter, provenance,
historical policy, refresh policy, validation, Production lifecycle, API and
frontend contract are present. Until then it remains `PARTIAL` or `NOT_BUILT`.
No implementation may bypass the provider/licence policy or invent missing data.

## Sources

- [Yahoo Finance quote-page research surfaces](https://help.yahoo.com/kb/SLN28277.html)
- [Yahoo Finance investment research overview](https://help.yahoo.com/kb/SLN28276.html)
- [Yahoo Finance historical prices, dividends and splits](https://in.help.yahoo.com/kb/finance/download-historical-data-yahoo-finance-sln2311.html)
