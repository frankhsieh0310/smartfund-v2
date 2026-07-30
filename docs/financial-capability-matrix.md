# Financial Capability Matrix

## Recoverability grades

| Grade | Definition | Production treatment |
| --- | --- | --- |
| A | Deterministic from dated canonical raw facts; independently reconcilable | Eligible after source and formula validation |
| B | Deterministic but depends on market-specific mapping, period alignment or declared peer universe | Eligible only with coverage/quality gate |
| C | Partially recoverable; source coverage or publication timing is incomplete | Display only with coverage and provenance warning |
| D | Cannot be reliably reconstructed from public canonical raw facts | Do not calculate; requires licensed snapshot data or a defined proprietary model |

## Capability coverage

| Metric family | Count | Calculate | Validate | Historical | SmartMatch | Compare | Alert | Rank | Score | Grade |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Valuation | 24 | 24 | 22 | 22 | 20 | 24 | 18 | 20 | 20 | A/B |
| Profitability & cash generation | 25 | 25 | 25 | 25 | 25 | 25 | 20 | 20 | 20 | A |
| Liquidity, leverage & efficiency | 23 | 23 | 23 | 23 | 21 | 23 | 18 | 18 | 18 | A/B |
| Growth & per-share | 20 | 20 | 20 | 20 | 20 | 20 | 18 | 18 | 18 | A |
| Return & price risk | 22 | 22 | 22 | 22 | 22 | 22 | 20 | 20 | 20 | A/B |
| Capital actions & ownership | 13 | 10 | 8 | 8 | 6 | 10 | 10 | 6 | 6 | B/C |
| Comparative & intelligence | 20 | 13 | 8 | 8 | 15 | 20 | 18 | 20 | 20 | B/C/D |
| **Total** | **147** | **137** | **128** | **128** | **129** | **144** | **122** | **122** | **122** | — |

## A/B/C/D distribution

| Grade | Metrics | Meaning |
| --- | ---: | --- |
| A | 90 | Raw facts and formula are deterministic and independently testable |
| B | 30 | Calculable after market mapping, peer-universe or period policy |
| C | 17 | Incomplete public history or delayed / inconsistent disclosure |
| D | 10 | Analyst snapshots, proprietary consensus, or undefined model outputs |

`D` is an honest unsupported state, not a failed calculation. It prevents
SmartFund from inventing analyst revision, forward PE or consensus history from
unrelated current values.
