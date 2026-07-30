# Historical Financial Engine Roadmap v1

## Objective

Build a historical, period-aware Financial Layer for **Taiwan (TWSE/TPEx,
1,977 stocks)** and **US (NASDAQ/NYSE/AMEX, 6,459 stocks)** while keeping Yahoo
price Daily and Global ETF Production validation running independently.

## Required historical layers

1. Statements: annual, quarterly and TTM income statement, balance sheet and
   cash flow, including per-share values and filing/restatement versions.
2. Valuation: historical PE, PB, PS, EV, EV/EBITDA and dividend yield.
3. Ratios: ROE, ROA, ROIC, gross/operating/net margin, current/quick ratio,
   debt/equity and interest coverage.
4. Events: dividends, corporate actions, ownership, estimates and revisions.

## Delivery phases

| Phase | Scope | Gate |
| --- | --- | --- |
| P0 | Preserve price Daily; audit/ingest raw statements, shares, dividends and corporate actions | Source catalog audited and canonical historical domains approved |
| P1 | Rebuild historical valuation and ratios from point-in-time statements/prices | Formula validation PASS and confidence recorded |
| P1.5 | Ownership changes, estimate revisions, event timelines and coverage dashboard | Snapshot/change history and provider publication dates retained |
| P2 | Expand validated Taiwan/US layer and then other markets | Taiwan/US Financial Historical Ready |

## Non-negotiable rules

- No derived metric enters Production until validation passes.
- Each value retains provider, source symbol, as-of/period date, publication
  date, restatement version and imported time.
- Price Daily, Global ETF validation and financial backfill run independently;
  financial work must not block Daily.
- Japan, Korea, Hong Kong, Canada, Australia, Europe and India remain lower
  priority until Taiwan and US Financial Layer is ready.
