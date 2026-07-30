# Raw Financial Data Master List

The machine-readable master is
[`config/raw-financial-data.json`](../config/raw-financial-data.json). It contains
the complete v1 canonical field inventory, grouped below.

| Raw domain | Examples | Why it is raw |
| --- | --- | --- |
| Market price | close, adjusted close, volume, VWAP, bid/ask | Observed market facts |
| Share capital | outstanding, weighted-average, float, treasury shares | Issuer/disclosure facts |
| Income statement | revenue, cost of revenue, operating income, tax, net income | Reported statement line items |
| Assets | cash, receivables, inventory, PPE, goodwill | Reported balance-sheet line items |
| Liabilities/equity | debt, leases, payables, retained earnings, minority interest | Reported balance-sheet line items |
| Cash flow | CFO, capex, acquisitions, debt issued/repaid, dividends paid | Reported cash-flow line items |
| Per share/distributions | EPS, dividend per share, split ratio, payment dates | Issuer/event facts |
| Corporate events | merger, spin-off, delisting, buyback, earnings date | Dated issuer facts |
| Ownership | holder shares, filing date, insider transaction | Filed disclosure facts |
| Analyst disclosure | published estimates, targets, ratings, actual surprise | Published vendor facts; not necessarily public |
| Metadata | issuer, period, filing, publication, restatement, source fact ID | Provenance and point-in-time facts |

No item in this list is a ratio. `PE`, `ROE`, margins and free cash flow are
defined in the formula library as outputs from these fields.
