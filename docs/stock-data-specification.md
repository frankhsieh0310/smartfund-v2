# SmartFund Stock Data Specification

> **Permanent minimum scope:** Yahoo Finance stock quote surfaces are the
> minimum SmartFund stock-data scope. The machine-readable authority is
> [`config/stock-data-specification.json`](../config/stock-data-specification.json).
> This is a specification only: it creates no downloader, API, schema, worker
> or scheduler.

## Permanent exclusion

News, articles, commentary, video, live streams and social/community content
are permanently excluded. SmartFund must not fetch, cache, quote, republish,
analyse or expose them. No sentiment may be derived from excluded content.

## Evidence used

Yahoo’s current help pages describe quote-page research surfaces including
Profile, Financials, Holders, Options, Sustainability and Historical Data.
Yahoo’s historical-data documentation confirms price, dividend and split data
for eligible quotes. The repository evidence used for current status is the
Prisma `Stock`, `StockHistory` and `StockTechnical` models, the Yahoo Chart
adapter, the technical-indicator script, and the three existing stock APIs.
Yahoo UI availability is conditional by security, market and licensing tier;
the specification never treats an unavailable Yahoo field as a fabricated
value.

## Coverage inventory

| Area | Yahoo availability | Current SmartFund status | Historical | Daily | API | Provider / cadence | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OHLC, adjusted close, volume, intraday and historical price | Yes | Partial | `stock_history` supports OHLCV/provenance | Partial by onboarded market | Partial | `YAHOO_CHART`; provider latest available | P0 |
| Average volume, turnover, VWAP, market cap, EV, 52-week metrics, bid/ask | Conditional | Partial / not built | No point-in-time statistics history | Not built | Not built | Yahoo quote summary; derived VWAP/turnover where defined | P1 |
| Yahoo chart + SmartFund extended technicals | Yes / derived | Partial | Existing: SMA, EMA, MACD, KD, RSI, ATR, Bollinger | Not built as Production lifecycle | Not built | Deterministic calculation from Yahoo OHLCV | P1 |
| Profile, executives, share structure | Conditional | Partial | Not built | Not built | Partial | Yahoo quote summary; change-only refresh | P1 |
| Income statement, balance sheet, cash flow, annual/quarterly/TTM | Conditional | Not built | Not built | Filing/release cadence | Not built | Yahoo quote summary; official fallback only by decision | P1 |
| Ratios and valuation | Conditional / derived | Not built | Not built | Quote + filing cadence | Not built | Yahoo quote summary + transparent calculation | P1 |
| Dividends and corporate actions | Partial | Partial adjusted-price effect only | No structured event history | Not built | Not built | Yahoo events; official provider needed for complete non-split actions | P1 |
| Ownership, insiders and short interest | Conditional | Not built | Not built | Report cadence | Not built | Yahoo holders/statistics | P2 |
| ESG / sustainability | Conditional/licensed | Not built | Not built | Provider cadence | Not built | Yahoo sustainability only after licence review | P2 |
| Analyst targets, estimates and revisions | Conditional/licensed | Not built | Not built | Provider cadence | Not built | Yahoo analysis only after licence review | P2 |
| Options | Conditional | Not built | Not built | Quote cadence | Not built | Yahoo options only after licence review | P3 |
| SmartFund proprietary scores | Not Yahoo | Not built | Not built | Not built | Not built | Versioned SmartFund scoring with input provenance | P2 |

## Exact field scope

The JSON specification lists every field within these groups, with the same
answer for Yahoo availability, current build state, historical lifecycle,
daily lifecycle, API, provider, update cadence and other-provider requirement.

- **Price:** Open, High, Low, Close, Adjusted Close, Volume, Average Volume,
  Turnover, VWAP, Market Cap, 52 Week High/Low, intraday, historical daily,
  weekly and monthly prices.
- **Technical:** SMA, EMA, MACD, RSI, KD, ATR, ADX, CCI, Williams %R, ROC,
  Momentum, OBV, VWAP, Bollinger Bands, Beta, historical volatility, distance
  to MA, Trend Score, support, resistance, breakout, gap and trend direction.
- **Profile:** company name, ticker, exchange, country, currency, sector,
  industry, GICS, description, website, employees, IPO date, CEO, executives,
  market cap, enterprise value, shares outstanding, float and fiscal year end.
- **Financials:** income statement, balance sheet, cash flow, annual,
  quarterly, TTM, revenue, profits, EPS, cash flow, capex, FCF, assets,
  liabilities, equity, cash and debt.
- **Ratios:** PE, Forward PE, PEG, PB, PS, dividend yield, ROE, ROA, ROIC,
  gross/operating/net margin, debt/equity, current/quick ratio, revenue/EPS
  growth, FCF, EV/EBITDA, EV/Sales and payout ratio.
- **Events:** dividend history, ex-date, payment date, split/reverse split,
  rights issue, symbol change, merger, spin-off and delisting.
- **Ownership:** major, institutional, mutual fund and ETF holders; insider
  holdings/transactions; short interest, shares short, short ratio and holder
  percentages.
- **Other Yahoo surfaces:** ESG/sustainability, analyst targets/consensus,
  earnings estimates/revisions/history/surprise, and options chains.
- **SmartFund-only:** AI, quality, growth, value, momentum, risk, composite
  and SmartMatch scores.

## Provider and implementation rules

1. `YAHOO_CHART` remains the sole market-price provider: historical uses
   `period=max`; Daily is incremental and validates **Provider Latest
   Available**, not today’s calendar date.
2. Quote/profile/financial/holder data requires a registered
   `YAHOO_QUOTE_SUMMARY` adapter before implementation. Corporate actions,
   sustainability, analysis and options each require their named adapter and a
   legal availability review.
3. SmartFund technicals are deterministic, versioned calculations from
   canonical Yahoo OHLCV. They do not create a duplicate price downloader.
4. Financial, ownership, ESG, analyst and event fields refresh on provider
   publication cadence; they are not falsely forced into a market-day schedule.
5. If Yahoo does not structurally or legally provide a required corporate
   action or licensed field, an official/approved provider must be committed
   before ingestion—never guessed or scraped around restrictions.

## Product priority

1. **P0:** price/history provenance and Production Daily for every stock
   market.
2. **P1:** quote statistics, full technical lifecycle, profile/share
   structure, statements, ratios, dividends and corporate actions.
3. **P2:** holders/short interest, ESG and analyst data after licence review,
   then SmartFund proprietary scores.
4. **P3:** options.
5. **Excluded:** all editorial, media and social/community content.

## Acceptance rule

SmartFund may claim a Yahoo field only after canonical storage, provenance,
historical policy where applicable, update cadence, validation, lifecycle
summary and a production API are all present. Until then the field remains
explicitly `PARTIAL` or `NOT_BUILT` in the specification.
