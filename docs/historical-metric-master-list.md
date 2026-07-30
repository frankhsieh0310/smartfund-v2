# Historical Metric Master List

The machine-readable metric inventory is
[`historical-metric-priority.json`](../config/historical-metric-priority.json).
It contains all currently identified stock metrics that can have historical,
period-aware observations: statements, valuation, profitability, growth,
dividends/actions, ownership, estimates, return/risk and market intelligence.

## Metric policy

1. A metric is historical only with an as-of/period date and source version.
2. Historical valuation requires point-in-time shares, price and statement data.
3. Historical ownership and estimates require report/revision vintages.
4. Any newly discovered metric is added here before schema or ingestion work.
5. Current count is generated from the arrays in the JSON file; the list is a
   discovery baseline, not a claim that all metrics are sourced or licensed.
