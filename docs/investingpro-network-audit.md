# InvestingPro Network Audit — Toyota `TSE:7203`

Audit timestamp: 2026-07-31 (Asia/Taipei)
Target: `https://hk.investing.com/pro/TSE:7203/explorer/pe_ltm`

## Scope and safety boundary

The available controlled browser was not authenticated: the page exposed a **登入** button. This audit did not read cookies, authorization headers, CSRF values, browser storage, credentials, or any protected profile. It also did not attempt to bypass the login or the subscription boundary.

The Browser control surface used for this audit exposes page DOM, console logs, and browser download events. It does not expose a safe request/response body inspector or CDP Network event stream. Accordingly, no request URL, payload, response body, or authentication material is fabricated here.

## Captured result

| Requirement | Result |
| --- | --- |
| Authenticated InvestingPro session visible | NO — page showed `登入` |
| Data Explorer Toyota `TSE:7203` visible | YES |
| Direct visible P/E history | YES — FY 2022–FY 2026 |
| Financial export / CSV/XLSX download observed | NO |
| Download event from P/E `計算範例` | NO event within 5 seconds |
| Sanitized Fetch/XHR URL | NOT_CAPTURED |
| Method / payload / response content type / schema | NOT_CAPTURED |
| Trading-item identifier in visible URL | YES — `TSE:7203` |
| Metric identifier in visible URL | YES — `pe_ltm` |
| Period support visible | YES — `FY, LTM` for `pe_ltm` |
| Session / CSRF dependency | NOT_VERIFIED; no sensitive values inspected |
| Rate-limit behavior | NOT_VERIFIED |

## Consequence

There is no real authenticated Network or Export evidence yet. Therefore no reusable endpoint, ticker substitution rule, pagination model, signed URL, request header policy, or production importer can be approved from this audit. The accompanying JSON is deliberately an empty sanitized capture with a machine-readable block reason, not a substitute for network evidence.
