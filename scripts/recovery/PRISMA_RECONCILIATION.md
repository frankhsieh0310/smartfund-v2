# Prisma / Live-DB Reconciliation Report (Phase C, Part 4-5 — read-only, no writes made)

## Headline numbers

- Live `public` schema tables: **463** (excluding `_prisma_migrations`)
- `model` blocks in `prisma/schema.prisma`: **284**
- Live tables with a Prisma model (`@@map` or model name match): **~263** (284 models map onto
  fewer distinct tables than model count due to shared table names? no — investigate before
  trusting this figure blindly; the authoritative number below is the direct table diff)
- Live tables with **no** Prisma model at all: **200**
- Prisma models whose mapped table **does not exist live**: **21** (see below — these are
  schema-only, never-migrated features, not drift to "fix" by deleting data)

## A. Prisma-managed (live table has a model + `@@map`, e.g. institutional_holdings ->
`InstitutionalHolding`, insider_ownership_transactions -> `InsiderOwnershipTransaction`,
production_scheduler_runs/checkpoints -> their models): confirmed present and correctly mapped.
No action needed.

## B. Raw-SQL-managed but production-required (live table, no Prisma model, accessed only via
`$queryRawUnsafe` from real API routes / cron / workflow code — this is intentional per the
existing `lib/consensus/*` and `lib/mobile-*` pattern, not an oversight):

| Table | Used by runtime routes |
|---|---|
| consensus_events | app/api/consensus/{accuracy,flips,personalized,rankings}, app/api/cron/consensus-{aggregate,backfill,performance,reprocess}, lib/consensus/{aggregate,backfill,flipDetect,freshness,persistEvent,personalize,reprocess}.ts |
| consensus_people | same consensus route/lib set |
| consensus_sources | app/api/cron/consensus-{backfill,ingest,performance}, lib/consensus/{aggregate,backfill,flipDetect,freshness,reprocess}.ts |
| consensus_stock_links | app/api/cron/consensus-{aggregate,backfill,performance}, lib/consensus/{aggregate,flipDetect,performance,persistEvent,personalize,reprocess}.ts |
| consensus_event_sources, consensus_flip_signals, consensus_person_accuracy, consensus_sector_daily, consensus_stock_daily, consensus_signal_performance, consensus_agreement_accuracy, consensus_ai_cache, consensus_alert_candidates, consensus_benchmark_map, consensus_inapp_notifications, consensus_meta, consensus_push_deliveries, consensus_push_installations, consensus_push_symbol_subscriptions, consensus_target_price_snapshots, consensus_viewpoint_flips | full consensus subsystem, same lib/consensus/*.ts set — 21 tables total, all `RAW_SQL_INTENTIONAL: YES` |
| political_persons | app/api/mobile/congress-trades/route.ts |
| political_transactions | app/api/mobile/congress-trades/route.ts |

**SHOULD_HAVE_PRISMA_MODEL: NO** for all of the above — these were deliberately built raw-SQL
(per [[smartfund-v2-consensus-radar]] memory: the whole consensus subsystem is a self-contained
raw-SQL feature area) and adding Prisma models now is optional cleanup, not a correctness gap.
**RAW_SQL_INTENTIONAL: YES**.

## C. Legacy/unknown — no live runtime reference found in `app/` or `lib/`, only in `scripts/`
(local desktop ingestion pipeline, not the Vercel production surface):

- `institutional_institutions`, `institutional_coverage_matrix`, `institutional_filings`,
  `institutional_holding_changes`, `institutional_ownership_disclosures`,
  `institutional_portfolio_analytics`, `institutional_portfolio_snapshots`,
  `institutional_security_mapping_queue`, `institutional_source_archives` — used by
  `scripts/data/institutional-holdings/*`
- `insider_issuer_relationships`, `insider_owner_aliases`, `insider_owners`,
  `insider_ownership_aggregates`, `insider_ownership_changes`, `insider_ownership_denominators`,
  `insider_ownership_eligible_issuers`, `insider_ownership_issuer_coverage`,
  `insider_ownership_owner_coverage`, `insider_ownership_snapshots`,
  `insider_ownership_source_cursors`, `insider_ownership_source_matrix` — used by
  `scripts/data/insider-ownership/*`, `scripts/data/insider/*`
- `economic_calendar_checkpoints` — `scripts/data/economic-calendar/*`
- `futures_positioning_archive_checkpoints` — `scripts/data/futures-positioning/*`
- Remaining ~150 tables (analyst_*, bond_*, crypto_*, futures_*, fx_*, global_index_*,
  economic_*, energy_*, credit_derivative_*, sovereign_debt_*, share_buyback_*, ipo_*, etc.) —
  all confirmed used only by `scripts/data/**` local ingestion scripts, not by any `app/api` or
  `app/workflows` runtime code.

**USED_BY_RUNTIME: NO** (local script only) — **SHOULD_HAVE_PRISMA_MODEL:** deferred; these are
real production data (populated by the desktop ingestion pipeline per
[[tw-data-updater-global-price-cloud]]) but not yet consumed by any live web/API route, so adding
Prisma models has no urgency until a route needs them. **RAW_SQL_INTENTIONAL: YES** for the
scripts that write them today.

## D. Temporary/staging: none identified as clearly disposable — no table name matched
`_staging`, `_temp`, `_scratch`, or similar in the live list.

## E. Can be removed later (flagged only, nothing deleted): 21 Prisma models whose `@@map`
target has no live table —
`shipping_indices`, `shipping_index_observations`, `shipping_index_derived`,
`earnings_calendar_events`, `earnings_calendar_event_revisions`, `earnings_actual_results`,
`earnings_estimates`, `earnings_coverage`, `insiders`, `insider_filings`,
`bond_auction_events`, `bond_lifecycle_events`, `bond_source_documents`,
`bond_ingestion_failures`, `watchlist_input_sources`, `ranking_metric_contracts`,
`ranking_definitions`, `ranking_universe_snapshots`, `ranking_snapshots`, `ranking_results`,
`ranking_work_items`.
These are schema-declared features whose migration was apparently never applied to the live DB
(shipping/earnings-calendar/ranking-engine are visible as `_pending` migrations in
`prisma migrate status`, i.e. planned-but-not-shipped, not orphaned-and-abandoned). Do not drop
these models — they represent unfinished feature work, not dead code.

---

# Part 5 — Migration Ledger Recovery Plan (proposal only, nothing executed)

`npx prisma migrate status` (read-only) shows:

- **90 local migrations** not recorded as applied in the DB ledger, diverging after the last
  common migration `20260805090000_global_crypto_platform`.
- **25 unique DB-ledger migrations** (27 raw rows — 2 names appear twice in the ledger itself,
  `20260722232853_add_data_source_registry` and `20260727094000_add_stock_history_provenance`,
  meaning the DB has two separate apply records for the same migration name) with **no
  corresponding `.sql` file anywhere on local disk**, spanning `20260629135952_init_production_schema`
  through `20260808145500_add_bond_market_observations`.

## 1. Classifying the 90 local-only migrations

Without executing anything, classification requires checking each migration's target
table/column against the live `information_schema` — not done exhaustively this round (90 way
too many to hand-verify individually in a read-only pass), but sampling strongly supports one
conclusion already stated in this document: **the tables these migrations create (consensus_*,
insider_ownership_*, institutional_*, most of the analyst/bond/crypto/futures/fx/global_index
additive schema from 2026-08-09 onward) already exist live** — confirmed directly via the table
list in Part 4. That means these 90 are almost certainly **"SQL already exists in live DB"**,
applied directly against Postgres (via `psql`/a script) rather than through
`prisma migrate deploy`, which is exactly the "raw SQL bypass" pattern already documented in
`db/consensus/*.sql` and `db/yahoo/*.sql`. A small number may be **"SQL partially exists"** —
migrations that both add new tables AND alter an existing table's columns, where only the
table-creation half might have landed. This round did not diff column-by-column for all 90; that
diff is the recommended next verification step (Part 5.3), not a blind `migrate resolve`.

## 2. The 25 DB-ledger migrations missing local `.sql` files

These predate `20260808145500`, cover the platform's original schema
(`init_production_schema`, `add_asset_layer`, `add_stock_platform`, etc.). Reconstruction
options:
- **From git history**: `git log --all --diff-filter=A -- 'prisma/migrations/2026062*'` etc. —
  not yet run this round; worth trying before assuming total loss, since a much older commit may
  still hold these folders even if the current working tree doesn't.
- **From Vercel build artifacts**: unlikely — build output doesn't retain `prisma/migrations/`
  source, only the generated client.
- **From a documented baseline instead of exact reconstruction**: since the live DB is the
  actual ground truth for what these migrations did, the safer path is not to reconstruct the
  original `.sql` verbatim but to snapshot the *current* live schema for those 25 tables/columns
  and encode that snapshot as one new baseline migration (see 5.3) — this documents "what state
  the DB is actually in" rather than "what a lost script once said," which is more trustworthy
  anyway.

## 3. Recommendation: documented baseline, not `migrate resolve`

Comparing the two options honestly:

- **`prisma migrate resolve --applied <name>` for all 90, one at a time** — risk: `resolve`
  takes the migration name on faith; if even one of the 90 only partially landed (the
  "partially exists" case in 5.1), marking it resolved permanently hides that gap from every
  future `migrate deploy`/`migrate status` check. This is exactly the failure mode Part 0 of this
  round's instructions were written to avoid ("禁止... prisma migrate resolve... 除非有逐
  migration 的證據" — and no round yet has produced that per-migration evidence).
- **Legacy migrations archived + new baseline** (recommended) — move the 90 unresolved local
  migrations and the unreconstructable 25 into a `prisma/migrations/_archive_pre_recovery/`
  folder (out of Prisma's active migration path, kept for history), then generate exactly one new
  baseline migration from `prisma db pull` output reflecting the live schema as it verifiably is
  today, and mark only that single new baseline as applied. This trades exact historical
  provenance for a ledger that is honest about "this is what's live right now" — much lower risk
  than 90 individual trust decisions, and matches the "寧可漏掉，不可錯誤歸因" principle already
  applied to attribution and stock-mapping work in this project: prefer an explicit gap
  (documented pre-recovery archive) over a silent wrong claim (resolving migrations whose exact
  effect was never verified).

**This round proposes but does not execute either option.** `MIGRATION_LEDGER_TOUCHED: NO`.
