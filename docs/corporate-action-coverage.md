# Corporate Action Coverage

Snapshot: 2026-07-31. SmartFund has adjusted-price history but does **not** yet have a dedicated global corporate-action event model or Production pipeline.

| Event / field | Canonical event schema | Actual stored data | Pipeline | Source | Global status | Planned refresh |
| --- | --- | --- | --- | --- | --- | --- |
| Stock split / ratio / effective date | No dedicated table | 2 symbols / 15 `yahoo.event.splitRatio` facts | Prototype | Yahoo Chart | Prototype | Daily incremental |
| Cash dividend / amount / ex-date | No dedicated table | 3 symbols / 225 `yahoo.event.cashDividend` facts | Prototype | Yahoo Chart | Prototype | Daily incremental |
| Record date / payment date | No | No evidence | None | Yahoo / official | Not started | Event-driven |
| Bonus share / rights issue / capital reduction | No | No evidence | None | Official exchange / filings | Not started | Event-driven |
| Spin-off / merger / acquisition | No | No evidence | None | Official filings / exchange | Not started | Event-driven |
| Ticker change / company rename | Partial master status only | No event history | Universe maintenance | Universe data | Partial | Maintenance |
| Listing / delisting | Partial master status only | No event history | Universe maintenance | Universe data | Partial | Maintenance |
| Historical revision | No | No evidence | None | Provider lineage | Not started | On provider correction |
| Incremental synchronization | Lifecycle available | No dedicated event job | None | — | Not started | Daily |

## Required canonical event model (roadmap only)

The first implementation must use a single event record with: `stockId`, `actionType`, effective/announcement/record/payment dates, amount or ratio, currency, old/new symbol, source, source event ID, source document URL, raw-payload reference, and timestamps. It must retain provider provenance and must not infer an event solely from adjusted close.

## Production gates

1. An action must be idempotently unique by provider event identity or deterministic fallback key.
2. Split events must reconcile against price-adjustment continuity.
3. Dividend dates, amount, and currency must pass validation.
4. Symbol changes/delistings must update the master without deleting history.

No schema, migration, or event worker was added in this documentation-only phase.
