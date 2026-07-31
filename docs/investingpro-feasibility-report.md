# InvestingPro Global Financial Data Feasibility — Toyota evidence report

## Decision

**NOT YET FEASIBLE AS A VERIFIED GLOBAL FINANCIAL DATABASE PROVIDER.**

This is not a negative claim about InvestingPro's subscription product. It is the only evidence-based conclusion possible from the controlled session: Toyota's Explorer renders meaningful visible financial metrics and a five-fiscal-year P/E history, but no authenticated export, structured response, raw archive, or update workflow was observable.

## Answers from real observed evidence

| Question | Result |
| --- | --- |
| A. Financial export format exists? | NOT_VERIFIED. No Toyota CSV/XLSX export observed. |
| B. Structured network response exists? | NOT_VERIFIED. No authenticated Network capture capability or evidence. |
| C. Historical depth? | P/E visibly has FY 2022–2026 only; all other depth NOT_VERIFIED. |
| D. Financial statement range? | Explorer exposes multiple metric pages, but statement history NOT_VERIFIED. |
| E. Annual / quarterly / LTM? | `pe_ltm` explicitly supports FY and LTM. Quarterly was not observed. |
| F. Forecast versus actual? | Forecast-labelled Explorer links exist. Actual/forecast payload fields NOT_VERIFIED. |
| G. Fields visible? | Yes; see the observed inventory. |
| Can it download full financial information? | NOT_VERIFIED. |
| Can it download full historical information? | NOT_VERIFIED. |
| Can it supply annual, quarterly, LTM history? | FY/LTM only for Toyota P/E is evidenced; remaining forms NOT_VERIFIED. |
| Can it provide P/E, P/B, P/S? | P/E actual history evidenced; P/B page exists; P/S not directly observed. |
| Can it distinguish actual and forecast? | NOT_VERIFIED. |
| Can it provide point-in-time filing availability? | NOT_VERIFIED. |
| Can it map 71,304 SmartFund stocks? | NOT_VERIFIED. A single observed trading item is `TSE:7203`. |
| Can it source latest incremental updates? | NOT_VERIFIED. |
| Can it provide corporate actions? | NOT_VERIFIED. |

## Observed Toyota proof

- Trading item: `TSE:7203`; company: Toyota Motor Corp.
- Page showed a price of `3,067.00 JPY` and current P/E `9.6x`.
- P/E visible history: FY 2022–FY 2026 (five rows), plus metadata showing supported periods `FY, LTM`.
- Explorer categories visible: valuation, dividend, risk, growth, efficiency, financial condition, forecast, stability, technical, ETF, and other metrics.
- Metric identifiers are visible in routes, including `total_rev`, `enterprise_value`, `pe_ltm`, `price_to_book`, `ev_to_ebitda_ltm`, `roe`, `roa`, `roic`, `current_ratio`, `div_yield`, and `total_debt`.

## Importer decision

**Do not create an InvestingPro importer or modify SmartFund financial ingestion.** There is no authenticated export/structured-response evidence to normalize, no raw archive, and no validated field schema. A future importer may only begin after a legitimate export or structured response has actually been captured, sanitized, and archived with the required provider/trading-item/period/provenance fields.

## Required condition to complete this audit

Use a supported browser session in which InvestingPro is visibly signed in and the subscription page is accessible. The remaining inspection is limited to visible Explorer controls and legitimate user-authorized downloads; no credential, cookie, token, or security bypass is required or requested.
