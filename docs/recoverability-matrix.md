# Historical Metric Recoverability Matrix

| Metric family | Recoverability | Required raw facts | Confidence ceiling | Reason |
| --- | ---: | --- | ---: | --- |
| PE / PB / PS / market cap / EV / EV multiples | 100% | point-in-time price, shares, statements, debt, cash | 99% | Formula is deterministic once definitions are versioned |
| Margins / ROE / ROA / liquidity / leverage / FCF | 100% | period-aware statements and prior-period balances | 99% | Formula is deterministic; issuer taxonomy mapping remains a quality risk |
| Dividend yield / total return / drawdown | 100% | price, adjusted-price, dividend and split events | 99% | Requires complete event adjustment history |
| Growth and historical percentiles | 100% | same raw facts plus complete period series | 98% | Depends on continuous history and restatement policy |
| Ownership change | partial | dated holder filings and holder identity mapping | 80% | Coverage/timing vary by jurisdiction |
| Short interest | partial | official short-interest publication | 80% | Published on a delayed, market-specific schedule |
| Analyst estimate / revision / consensus / target | 0–30% | vendor estimate snapshots | 40% | Point-in-time vendor snapshots are usually proprietary |
| Recommendation upgrades/downgrades | 0–30% | dated analyst actions | 40% | Not fully public or standardized |
| Factor exposure / peer rank | model-dependent | declared universe and model inputs | 70% | Recoverable only after model specification is locked |

`config/formula-library.json` is the authoritative implementation registry for
recoverable outputs. Its `nonRecoverable` array records facts that must not be
fabricated from public statements.
