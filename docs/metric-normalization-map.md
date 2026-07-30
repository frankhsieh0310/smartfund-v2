# Derived Metric Normalization Map

Derived metrics are normalized into **147 logical outputs**. They are generated
from the canonical raw groups, not independently ingested. An output is only
available when all raw dependencies are point-in-time valid.

| Family | Count | Normalized outputs |
| --- | ---: | --- |
| Valuation | 24 | market cap; EV; PE; PB; PS; PEG; EV/EBITDA; EV/EBIT; EV/sales; earnings/FCF/dividend yield; historical multiples; 5Y/10Y average; percentile; premium/discount |
| Profitability & cash generation | 25 | EBIT; EBITDA; NOPAT; FCF; CFO; gross/operating/EBITDA/EBIT/net margins; ROE; ROA; ROIC; CROIC; FCF conversion; cash conversion; return on capital variants |
| Liquidity, leverage & efficiency | 23 | current/quick/cash ratio; debt/equity; debt/assets; net debt; net-debt/EBITDA; interest coverage; fixed-charge coverage; asset/inventory/receivable/payable turnover; DSO/DIO/DPO; cash conversion cycle |
| Growth & per-share | 20 | QoQ/YoY/CAGR revenue, gross profit, EBIT, EBITDA, EPS, FCF, book value, dividend and shares; basic/diluted EPS; BVPS; payout; retention |
| Return & price risk | 22 | price/dividend/total return across 1M/3M/6M/YTD/1Y/3Y/5Y/10Y/since-inception; volatility; beta; Sharpe; Sortino; tracking error; information ratio; drawdown; recovery days |
| Capital actions & ownership | 13 | buyback yield; issuance dilution; net share change; dividend growth/streak; holder ownership; holder change; insider net buy/sell; short ratio; days to cover; float short |
| Comparative & intelligence | 20 | sector/industry percentile and rank for valuation, profitability, growth, size and risk; historical percentile; support/resistance; trend and factor outputs, provided declared benchmark/universe/model inputs exist |

## Capability rules

- `Can Calculate` requires formula dependencies only.
- `Can Validate` requires an independent source, formula reconciliation or
  deterministic accounting identity.
- `Can Historical` requires complete dated raw dependencies with no look-ahead.
- `Can SmartMatch`, `Can Compare`, `Can Alert`, `Can Rank` and `Can Score`
  require the preceding capabilities plus a declared peer universe, benchmark,
  threshold or scoring policy.

The 44 formulas in `config/formula-library.json` are the explicit v1 formula
definitions. The remaining logical outputs are parameterized variants of those
definitions (period, benchmark, peer universe or aggregation); they must not be
implemented until their parameter policy is locked.
