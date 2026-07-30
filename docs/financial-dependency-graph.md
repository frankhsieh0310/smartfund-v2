# Financial Dependency Graph

```mermaid
flowchart TD
  Price["Close Price"] --> MC["Market Cap"]
  Shares["Shares Outstanding"] --> MC
  Price --> PE["PE"]
  EPS["TTM Diluted EPS"] --> PE
  Price --> PB["PB"]
  Equity["Shareholders' Equity"] --> BVPS["Book Value per Share"]
  Shares --> BVPS
  BVPS --> PB
  MC --> EV["Enterprise Value"]
  Debt["Total Debt"] --> EV
  Cash["Cash + Short-term Investments"] --> EV
  EV --> EVEBITDA["EV / EBITDA"]
  EBITDA["TTM EBITDA"] --> EVEBITDA
  Income["TTM Net Income"] --> ROE["ROE"]
  Equity --> ROE
  Dividend["TTM Dividend per Share"] --> DY["Dividend Yield"]
  Price --> DY
```

The full executable graph is
[`config/dependency-graph.json`](../config/dependency-graph.json). All graph
edges carry a point-in-time rule: financial facts must have been public at the
valuation date.
