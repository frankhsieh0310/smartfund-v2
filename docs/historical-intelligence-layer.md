# Historical Intelligence Layer v1

## Scope

This layer creates no new raw fact and no new accounting formula. It transforms
the **128 historical-capable metric series** from the Financial Capability
Matrix into a consistent user-facing metric vocabulary.

## Intelligence primitives

| Primitive | Meaning | Eligible series | Count |
| --- | --- | ---: | ---: |
| Current | Latest provider-valid observation | 128 | 128 |
| Historical average / median / min / max | 3Y, 5Y, 10Y and full-history summary | 110 | 770 |
| Percentile / z-score / historical rank | Current position within own point-in-time history | 110 | 330 |
| Rolling mean / trend / above-below average | 1Y, 3Y, 5Y rolling direction and deviation | 110 | 440 |
| Peer rank / peer percentile | Same date, declared peer universe | 100 | 200 |
| Stability / improvement / consecutive direction | Dispersion, trend persistence, sequential change | 82 | 246 |
| CAGR / acceleration | Multi-year growth from valid period series | 70 | 210 |
| Drawdown / recovery / risk regime | Return series path characteristics | 22 | 66 |
| Dividend continuity | CAGR, stability, consecutive growth, cut count | 5 | 25 |
| **Total Historical Intelligence Metrics** | Parameterized, independently addressable outputs | — | **2,415** |

An output is identified by `(base_metric, intelligence_type, window,
as_of_date, peer_universe_version, formula_version)`. For example,
`pe_ttm.historical_percentile.5Y` and `roe.stability.10Y` are separate,
addressable metrics.

## Examples

| Base series | Intelligence outputs |
| --- | --- |
| PE | current; 3Y/5Y/10Y average; median; min/max; percentile; z-score; rolling mean; trend; above/below average; historical rank; peer rank |
| ROE | current; averages; stability; consecutive improvement; percentile; historical rank; peer rank; trend; improvement |
| Dividend/share | CAGR; growth streak; stability; cut count; percentile; payout trend; peer rank |
| Revenue / EPS / FCF | YoY; CAGR; acceleration; rolling growth; trend; historical percentile; stability; peer rank |
| Margin / leverage / liquidity | current; rolling mean; trend; percentile; z-score; stability; peer rank; threshold alert |
| Return / risk | multi-period return; volatility; Sharpe; Sortino; beta; drawdown; recovery; percentile; benchmark comparison |

## Guardrails

- Windows with insufficient observations return `INSUFFICIENT_HISTORY`, not a
  fabricated value.
- Historical rank is intra-entity and point-in-time; peer rank is cross-entity
  and requires a versioned peer universe.
- All alerts include the threshold, window and observation count that caused
  them.
- Grade C/D inputs retain their availability warning; this layer cannot upgrade
  source quality.
