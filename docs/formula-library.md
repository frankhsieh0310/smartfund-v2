# Canonical Formula Library

The formula library is in
[`config/formula-library.json`](../config/formula-library.json).

| Output family | Examples | Required raw facts | Refresh |
| --- | --- | --- | --- |
| Valuation | market cap, PE, PB, PS, EV, EV/EBITDA | price, shares, statements, debt, cash | daily + filing |
| Profitability | gross, operating, net margin; ROE; ROA | income statement, assets, equity | filing |
| Liquidity/leverage | current ratio, quick ratio, debt/equity, coverage | current assets/liabilities, debt, cash, interest | filing |
| Cash generation | free cash flow | operating cash flow, capex | filing |
| Shareholder return | dividend yield, total return | dividend events, price, splits | daily + event |

Formula publication is blocked until inputs, point-in-time dates, source facts
and an independent recalculation check are present.
