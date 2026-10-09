# SmartFund Global FX Data Platform

## Scope and state

This subsystem owns FX only. It does not write Stock, ETF, Fund, Bond,
Economic, Commodity, Crypto, UI, or Website records. The Desktop builder has
completed the repository implementation and is **Railway handoff ready**, but
is not retired until the production migration, seed, bounded historical run,
and validation all pass.

The only production service remains `smartfund-v2`. Its existing cron process
dispatches the FX incremental runner as an independently locked lifecycle job.

## L0–L24 mapping

| Layers | Implementation |
| --- | --- |
| L0 | `fx_sources`: 13 official institutions plus a legal public market source |
| L1 | `fx_currencies`: 33 required fiat/onshore/offshore currencies |
| L2 | `fx_pairs`: deterministic canonical universe of 528 Major/Minor/Cross/Exotic pairs |
| L3, L19 | `fx_coverage`: capability/interval availability, missing state and quality |
| L4 | `fx_candles`: 1m, 5m, 15m, 30m, 60m, derived 2h/4h/6h/12h, 1D, 1W, 1M OHLC/bid/ask/mid/spread/volume |
| L5–L6 | `fx_latest_quotes` with quote and ingestion timestamps for freshness |
| L7–L9 | `fx_reference_values`: official fixing, central-bank rate and FX index series |
| L10–L14 | `fx_metrics`: volatility, derived analytics, technical, chart-ready and comparison payloads |
| L15–L16, L18 | production FX runner plus shared scheduler lock/run/checkpoint and FX retry queue |
| L17 | `fx_archive_manifests`: checksummed archive ranges and restore-verification state |
| L20–L21 | coverage quality state and `validate-fx-platform.ts` validation gate |
| L22 | idempotent incremental mode and bounded retry work |
| L23 | existing `scripts/data/production/run-production-cron.ts`; no new Railway service |
| L24 | retirement only after the production gate below passes |

## Safety contract

- One writer per FX job is enforced through `production_scheduler_locks`.
- Every invocation is bounded by `--max-pairs` (default 20, hard maximum 100).
- Every pair advances the durable shared checkpoint.
- Candle writes are idempotent composite-key `createMany(...skipDuplicates)`
  operations in chunks of at most 500 rows.
- Pair failures are upserted into `fx_work_items`; a provider failure never
  causes a cross-asset write and does not discard checkpoint progress.
- No credential is embedded in config, logs, payloads, or source URLs.

## Production handoff gate

Run these in `smartfund-v2` after migration-history reconciliation:

```text
npx prisma migrate deploy
npm run data:fx:seed
npm run data:fx:backfill -- --interval=1d --max-pairs=20
npm run data:fx:validate
```

Continue bounded `--resume` slices for every configured interval. Intraday
provider retention is recorded as actual coverage, never represented as full
history. The builder may be marked retired only when validation is `PASS`, all
minimum interval jobs are terminal, the retry queue has no unresolved permanent
gap without a documented source limitation, and Railway incremental evidence is
fresh.

## Current production blocker

Production migration history diverges from the repository. Both
`20260805090000_global_crypto_platform` and
`20260805120000_global_fx_platform` are locally pending, while multiple
production migrations are absent locally. Running `prisma migrate deploy` now
would attempt an unrelated Crypto write and violates the FX constitution.
No production migration or data write was performed. Reconcile the migration
history (without editing an applied migration) before executing the handoff gate.
