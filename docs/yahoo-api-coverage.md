# Yahoo API Coverage — Technical Map

**Scope:** endpoint behavior observed through the installed Yahoo client and live
read-only calls for `AAPL` and `2330.TW` on 2026-07-30. “API” here means a reachable
HTTP JSON/CSV surface, not a statement about support status.

| Surface / module | Endpoint pattern | Response | Authentication in observed probe | Pagination / range | Historical | AAPL | 2330.TW |
|---|---|---|---|---|---|---:|---:|
| Quote summary | `https://query2.finance.yahoo.com/v10/finance/quoteSummary/{symbol}?modules=...` | JSON object by module | Client obtained a crumb automatically; no interactive login | Module list; no page pagination | Partial per module | 30 modules | 27 modules |
| Chart | `https://query2.finance.yahoo.com/v8/finance/chart/{symbol}` | JSON timestamps, indicators, metadata, events | No interactive login | `period1`, `period2`, `interval`, `events` | Yes | 6,682 rows | 6,613 rows |
| Historical download | `https://query2.finance.yahoo.com/v7/finance/download/{symbol}` | CSV | Not directly executed | Date range and interval parameters | Yes | Not executed | Not executed |
| Fundamentals time series | `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{symbol}` | JSON `timeseries.result[]` | No interactive login | `period1`, `period2`, comma-separated typed keys | Yes | 5 annual periods | 5 annual periods |
| Options | `https://query2.finance.yahoo.com/v7/finance/options/{symbol}` | JSON option chain | Not probed | Expiry parameter | Expiry-chain history only | Route exists | Route exists |
| Quote batch | `https://query2.finance.yahoo.com/v7/finance/quote?symbols=...` | JSON quote array | Not probed in this audit | Symbol list | Current / intraday | Declared client surface | Declared client surface |
| Search | Yahoo search endpoint used by client | JSON search results | Not probed | Query text | N/A | Declared client surface | Declared client surface |
| Screener | Yahoo screener endpoint used by client | JSON result set | Not probed | Offset/count filters | Current screens | Declared client surface | Declared client surface |

## Endpoint behavior

| Question | Observed answer |
|---|---|
| JSON available? | Yes — quote summary, chart, fundamentals time series, options and quote client modules return JSON. |
| CSV available? | The client declares a historical download endpoint. The browser CSV download was not executed. |
| XHR/fetch available? | Yes — the endpoint patterns above are HTTP requests used by the client. Browser Network capture was unavailable in the current browser control surface, so this audit records client-invoked requests rather than a DevTools HAR. |
| Hidden endpoint? | These URLs are endpoint-level surfaces not shown as ordinary symbol-page navigation. The audit calls them **endpoint surfaces**, not a claim that Yahoo documents them. |
| GraphQL available? | **Not observed.** No GraphQL route or request was found in the installed client or two live page probes. |
| Rate limit | **Not established.** No published/observed numeric threshold was obtained; this audit records it as unknown. |
| Pagination | Quote-summary is module-selective, chart/time-series are range-selective, options are expiry-selective; no cursor pagination was observed for these calls. |

## Financial statement request model

The time-series request selects an explicit period prefix and raw fact keys:

```text
period1=<unix>&period2=<unix>&type=
annualTotalRevenue,annualNetIncome,...
```

The three technical statement groups are:

- `financials` — income statement
- `balance-sheet` — balance sheet
- `cash-flow` — cash flow statement

Each accepts `annual`, `quarterly` and `trailing` request types. The observed values
are report-period data, and fields omitted by Yahoo are absent from the JSON payload.

