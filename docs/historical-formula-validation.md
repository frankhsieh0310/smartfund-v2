# Historical Formula Validation

## Status

`NOT_STARTED`: no derived financial metric may be published yet.

## Validation pipeline

1. Select an instrument, historical period, statement version and source.
2. Rebuild metric from canonical point-in-time values.
3. Compare, where available, with Yahoo, CompaniesMarketCap, Macrotrends,
   FullRatio, StockAnalysis and an official filing/source.
4. Persist a Difference Report: value, absolute/relative difference, units,
   currency, fiscal period, publication date and source timestamps.
5. Calculate a Confidence Score from source authority, agreement, unit/currency
   consistency, restatement alignment and formula determinism.
6. Mark `PASS`, `INVESTIGATE` or `FAIL`. Only `PASS` metrics may enter
   Production APIs or scores.

## Initial formulas

- PE = point-in-time market cap / trailing attributable earnings.
- PB = point-in-time market cap / attributable equity.
- PS = point-in-time market cap / trailing revenue.
- EV/EBITDA = enterprise value / trailing EBITDA.
- ROE, ROA, ROIC, margins, liquidity and leverage use explicitly versioned
  denominator conventions.

Every calculation stores its formula version. The implementation must never
compare values from different fiscal periods, currencies, share bases or
restatement versions as if they were equivalent.
