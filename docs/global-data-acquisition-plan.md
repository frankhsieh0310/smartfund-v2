# SmartFund Global Data Acquisition Plan

> **Permanent provider authority.** All Historical and Daily work must use the
> source selected in [`config/global-data-acquisition-plan.json`](../config/global-data-acquisition-plan.json).
> A provider change requires a committed Plan update and a registered adapter.

## Active provider adapters

| Adapter | Provider | Asset classes | Latest rule |
| --- | --- | --- | --- |
| `YAHOO_CHART` | Yahoo Chart API | Stocks, ETF, market index, volatility, commodity, FX, crypto | Provider Latest Available |
| `FRED` | Federal Reserve Economic Data | Macro and mapped US yields | Provider Latest Available |
| `ECB` | ECB Data API | ECB macro/rate series | Provider Latest Available |

## Provider decisions

| Asset | Legal provider | Historical | Daily | Adapter | Current decision |
| --- | --- | --- | --- | --- | --- |
| TWSE, TPEx, NASDAQ, NYSE, AMEX, Japan, HKEX, KRX, SSE, SZSE stocks | Yahoo | Chart `period=max` | Chart incremental | `YAHOO_CHART` | Declared |
| Taiwan ETF / Global ETF | Yahoo | Chart `period=max` | Chart incremental | `YAHOO_CHART` | Declared |
| Mutual funds | **Unresolved** | No legal Production source selected | Blocked | — | Yahoo mappings and legacy MoneyDJ evidence conflict; no registered Fund adapter exists |
| FRED Macro (24 series) | FRED | Series observations | Incremental | `FRED` | Active |
| ECB Macro/rates (3 series) | ECB | ECB Data API | Incremental | `ECB` | Active |
| IMF (90), OECD (22), World Bank (16) macro series | Official named provider | Existing history only | Provider pending | — | Adapter required; not blocked for FRED/ECB |
| US yields | FRED | `DGS3MO`, `DGS2`, `DGS5`, `DGS10`, `DGS30` | Incremental | `FRED` | Active |
| Market index / Volatility | Yahoo | Chart `period=max` | Chart incremental | `YAHOO_CHART` | Declared / Active |
| Commodity / Precious metals / Energy | Yahoo where listed | Chart `period=max` | Chart incremental | `YAHOO_CHART` | Declared; unavailable symbols require a future committed decision |
| FX / Crypto | Yahoo-listed pairs | Chart `period=max` | Chart incremental | `YAHOO_CHART` | Declared; no CoinGecko/CoinMarketCap adapter is selected |
| REIT / Insurance | **Unresolved** | No legal Production source selected | Not started | — | Provider decision and adapter required |

## Legacy Queue Snapshot

> Superseded by the **Permanent Asset Priority** below. The Production
> Dashboard regenerates its queue from the Plan automatically.

The Queue is automatically derived from the Data Completion Dashboard plus this
Plan's provider gate. It prioritizes a declared/active provider with a missing
Production Daily lifecycle ahead of historical perfection; unresolved provider
classes remain visible but cannot be ingested until a decision is committed.

1. Global ETF — Yahoo / `YAHOO_CHART`; finish bounded Daily validation.
2. NYSE — Yahoo / `YAHOO_CHART`; close current Historical/Daily lifecycle.
3. AMEX — Yahoo / `YAHOO_CHART`; enable Daily after Historical Ready.
4. Taiwan ETF — Yahoo / `YAHOO_CHART`; complete historical coverage and Daily.
5. Commodity, precious metals, energy, FX, crypto — Yahoo / `YAHOO_CHART`; Production Daily/API after symbol availability validation.
6. Funds, REIT, insurance — blocked only by a formal provider decision and adapter; do not guess a source.

## Permanent Asset Priority

The authoritative queue is **Provider + Product Value**, not market sequence:

1. Global ETF
2. Taiwan ETF
3. Funds
4. Yahoo assets: Commodity, Energy, Precious Metal, FX, Crypto
5. REIT
6. Insurance
7. IMF
8. OECD
9. World Bank

NYSE, AMEX, Japan, HKEX and other exchanges stay exclusively in the Stocks
lifecycle. A ProviderAdapter is completed once and reused by every eligible
asset; asset workflows must not create duplicate downloaders.

## Production gate

`Provider declared → Adapter registered → incremental-only Daily → Run Ledger,
lock, checkpoint/resume, failure queue, validation and summary → Website API`.
The latest value is the provider's latest available valid observation, not the
calendar date.
