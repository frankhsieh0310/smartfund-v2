# Metric Intelligence Library

## Canonical transformations

| ID pattern | Calculation | Valid for | Validation |
| --- | --- | --- | --- |
| `{m}.current` | latest provider-valid value | all historical series | freshness + provenance |
| `{m}.mean.{3Y|5Y|10Y}` | arithmetic mean over dated observations | continuous series | window and count check |
| `{m}.median.full` | median of full valid history | continuous series | independent aggregation |
| `{m}.{min|max}.{window}` | extrema in a dated window | continuous series | date/value check |
| `{m}.percentile.{window}` | empirical percentile at as-of date | continuous series | no-look-ahead test |
| `{m}.zscore.{window}` | `(current - mean) / standard deviation` | non-zero variance | independent aggregation |
| `{m}.trend.{window}` | slope/sign of normalized rolling series | continuous series | regression replay |
| `{m}.deviation_from_mean.{window}` | `(current / mean) - 1` | positive-denominator series | arithmetic replay |
| `{m}.stability.{window}` | inverse normalized dispersion | recurrent periodic series | observation-count rule |
| `{m}.improvement.{window}` | change in latest vs prior comparable point | periodic series | period alignment |
| `{m}.consecutive.{direction}` | uninterrupted sequential direction count | periodic/event series | ordered-event replay |
| `{m}.cagr.{window}` | annualized start-to-end growth | positive, valid endpoints | endpoint and interval check |
| `{m}.peer_percentile.{universe}` | percentile within declared peer universe | peer-eligible metrics | universe version check |
| `{m}.peer_rank.{universe}` | ordinal rank within declared peer universe | peer-eligible metrics | universe version check |
| `{m}.alert.{rule}` | threshold/crossing/persistence event | alert-eligible metrics | threshold audit |

## Availability matrix

| Intelligence family | Search | Sort | Compare | Alert | Backtest | Score |
| --- | --- | --- | --- | --- | --- | --- |
| Current / historical summary | YES | YES | YES | threshold only | YES | YES |
| Percentile / z-score / deviation | YES | YES | YES | YES | YES | YES |
| Trend / stability / improvement | YES | YES | YES | YES | YES | YES |
| Growth / CAGR / consecutive | YES | YES | YES | YES | YES | YES |
| Peer rank / peer percentile | YES | YES | YES | YES | YES | YES |
| Drawdown / risk regime | YES | YES | YES | YES | YES | YES |
| Grade C input transformation | YES, with warning | YES, with warning | YES, with warning | NO default | NO default | NO default |
| Grade D input transformation | NO | NO | NO | NO | NO | NO |

The library is a generator specification. It prevents each page or SmartMatch
rule from inventing a different definition of “cheap”, “stable” or “improving”.
