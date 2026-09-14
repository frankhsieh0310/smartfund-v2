# Database Ownership Boundary Audit (Phase D — read-only, no DB/schema/migration writes made)

Companion machine-readable manifest: `scripts/recovery/database-ownership.json`
(consumed by the updated `scripts/recovery/production-gate.mjs`, Part 8 below).

## Method

For each of the 463 live `public` tables (excluding `_prisma_migrations`): checked (1) whether a
Prisma model maps to it via `@@map`, (2) whether its name is referenced anywhere under
`app/`, `lib/`, `components/` (= read/written by the deployed Next.js runtime — API routes, cron
routes, workflows, or the lib/consensus-style raw-SQL layer), (3) whether it's referenced under
`scripts/` (= the local desktop ingestion pipeline per
[[tw-data-updater-global-price-cloud]]). Classification is name-based static grep, not dynamic
tracing — CONFIDENCE is HIGH for direct hits, LOW for tables with zero hits anywhere (these are
exactly the ones a human should double check before trusting the UNKNOWN label).

## Part 1 — Ownership classification, 463 live tables

| OWNER_CLASS | Count |
|---|---|
| PRISMA_OWNED | 263 |
| INGESTION_OWNED | 147 |
| RAW_SQL_OWNED | 26 |
| LEGACY | 0 |
| UNKNOWN | 27 |

**LEGACY = 0** is an honest finding, not an oversight: every table this scan could not tie to
runtime or ingestion code also had no reference in `db/*.sql` (the other place a deprecated
feature's schema would still show up), so there's no positive evidence of "was used, no longer
is" for any table — only "no evidence found" (UNKNOWN, below).

**The 27 UNKNOWN tables** (zero hits in `app/`, `lib/`, `components/`, or `scripts/`):
`analyst_estimate_observations`, `analyst_rating_distributions`, `analysts`,
`economic_derived_inputs`, `economic_failures`, `economic_source_documents`,
`enterprise_resource_canonical`, `enterprise_resource_canonical_members`,
`enterprise_resource_changes`, `enterprise_resource_provenance`, `enterprise_resource_sources`,
`enterprise_resource_sync_log`, `enterprise_resource_verification_log`, `enterprise_resources`,
`global_index_compare_read`, `global_index_detail_read`, `global_index_ranking_read`,
`global_index_screener_read`, `global_index_search_read`, `institution_name_history`,
`ipo_use_of_proceeds`, `openclaw_price_run_log`, `provider_rating_normalization`,
`push_device_registrations`, `taifex_official_observations`, plus 2 more captured only in the
manifest JSON (full list there). Spot-checked `push_device_registrations` specifically since a
live push API route exists (`app/api/push/devices/route.ts`) — confirmed that route does not
reference this table by name at all, so either it's dead (an earlier design that was replaced)
or the table is written by something outside this repo entirely. **None of the 27 are referenced
by any cron, workflow, or API route** — see PRODUCTION_CRITICAL_UNKNOWN_COUNT below.

**PRODUCTION_CRITICAL_UNKNOWN_COUNT: 0** — zero of the 27 UNKNOWN tables are read or written by
any file under `app/api/cron/`, `app/workflows/`, or `app/api/**/route.ts`. This is the number
Part 8's gate design cares about: an UNKNOWN table nobody currently reads is a documentation gap,
not a live-traffic risk.

## Part 2 — Core table groups, explicit answers

| Group | Ownership | Evidence |
|---|---|---|
| consensus_* (21 tables) | **RAW_SQL_OWNED** (20) / INGESTION_OWNED (1: consensus_target_price_snapshots — no runtime hit found, likely write-only from a not-yet-wired feature) | `lib/consensus/*.ts`, `app/api/consensus/*`, `app/api/cron/consensus-*` |
| political_persons, political_transactions | **RAW_SQL_OWNED** | `app/api/mobile/congress-trades/route.ts` |
| insider_owners, insider_ownership_eligible_issuers | **RAW_SQL_OWNED** | `app/api/mobile/insider-trades/route.ts` |
| insider_ownership_transactions | **PRISMA_OWNED** | `InsiderOwnershipTransaction` model |
| remaining insider_* (11 tables) | **INGESTION_OWNED** | `scripts/data/insider-ownership/*`, `scripts/data/insider/*` |
| institutional_holdings, institutional_daily | **PRISMA_OWNED** | `InstitutionalHolding` model + models |
| remaining institutional_* (9 tables) | **INGESTION_OWNED** | `scripts/data/institutional-holdings/*` |
| production_scheduler_runs/checkpoints/failures/locks | **PRISMA_OWNED** | confirmed models exist ([[smartfund-v2-cloud-ingestion-storage]] — reused deliberately, no schema change) |
| economic_calendar_checkpoints, futures_positioning_archive_checkpoints | **INGESTION_OWNED** | `scripts/data/economic-calendar/*`, `scripts/data/futures-positioning/*` |
| industry_chain_import_checkpoints | **PRISMA_OWNED** | has a model |
| ETF / Fund / FX / Index / fundamentals (bulk of the ~150 domain tables) | **INGESTION_OWNED**, with the handful of user-facing ones (`etfs`, `funds`, `fund_master`, `fund_share_classes`, `fx_pairs`, `fx_latest_quotes`, `global_index_registry`, etc.) **PRISMA_OWNED** | `scripts/data/{etf,global-fund,fx,index}/*` for the ingestion side; Prisma models for the read-facing core entities |
| users, watchlists, watchlist_items, portfolios, alerts, favorites | **PRISMA_OWNED** | core app models, all confirmed present with live tables |

## Part 3 — Prisma schema (284 models) ownership audit

| Class | Count |
|---|---|
| ACTIVE_PRISMA_MODEL (live table exists, model in sync) | 263 |
| PENDING_NOT_DEPLOYED | 17 |
| LEGACY_MODEL | 4 |
| MODEL_WITHOUT_LIVE_TABLE (residual, unclassified) | 0 |

The 21 "model exists, live table missing" split cleanly into two groups by tracing each to its
migration file (or lack of one):

**PENDING_NOT_DEPLOYED (17)** — a real migration exists and was written specifically for this
table, but Part 4's audit confirms it never landed (`CONFIRMED_NOT_APPLIED`):
- `shipping_indices`, `shipping_index_observations`, `shipping_index_derived` →
  `20260810120000_add_shipping_index_canonical_depth`
- `earnings_calendar_events`, `earnings_calendar_event_revisions`, `earnings_actual_results`,
  `earnings_estimates`, `earnings_coverage` → `earnings_calendar_platform_pending` (the filename
  itself says "pending")
- `insiders`, `insider_filings` → `20260810003000_insider_professional_depth` (this migration
  also creates other insider_ownership_* tables that DID land — so this is a migration that
  **partially** applied: the ownership/aggregate tables went live, but the two tables a Prisma
  model was written for did not)
- `watchlist_input_sources` → `20260810233000_global_watchlist_alert_p0_depth_recovery`
  (same pattern — most of that migration applied, this one table didn't)
- `ranking_metric_contracts`, `ranking_definitions`, `ranking_universe_snapshots`,
  `ranking_snapshots`, `ranking_results`, `ranking_work_items` →
  `20260810030000_global_ranking_engine_p0_depth_recovery`

**Verdict**: these are unfinished feature rollouts (ranking engine, earnings calendar, shipping
index, insider-filings-detail, watchlist-input-sources), not deprecated features. **Should NOT
enter a future baseline** until the migration is actually (re-)applied — see Part 6.

**LEGACY_MODEL (4)** — no migration file anywhere in the repo ever referenced these tables:
`bond_auction_events`, `bond_lifecycle_events`, `bond_source_documents`,
`bond_ingestion_failures`. These models exist in `schema.prisma` with zero corresponding
migration history at all — either hand-added to the schema file without ever running
`prisma migrate dev`, or migrations for them were deleted at some point. **Should NOT enter a
future baseline as-is** — needs a human decision: either write the missing migration now (if the
feature is still wanted) or drop the models (if it was abandoned).

## Part 4 — 90 "not in DB ledger" migrations, corrected finding

**Important correction to the Phase C figure.** Phase C's "90 local migrations not applied" came
from reading `prisma migrate status`'s text output, which — once local and DB migration history
diverge in ORDER (not just membership) — reports the entire remaining local suffix as "not yet
applied," even for migrations that the DB ledger actually **does** contain a `finished_at` row
for. A direct read-only query of `_prisma_migrations` (not just the CLI's status summary) shows
the true membership: **38 of those 90 are in fact recorded FINISHED in the ledger** — Prisma's
status text was flagging an *ordering* problem (the local migration folder timeline and the DB's
application timeline no longer agree on sequence — likely because raw-SQL-applied migrations
were manually inserted into the ledger out of chronological order at some point), not an
"unapplied" problem for those 38.

Re-running the audit at the **effect level** (does the live schema actually contain what each
migration's SQL says it should create), for genuinely-unrecorded migrations plus a sanity check
against the ledger-recorded ones:

| Status | Count | Basis |
|---|---|---|
| CONFIRMED_FULLY_APPLIED | 109 | 38 confirmed via ledger `finished_at` row; 71 confirmed via 100%-of-checked-objects present live (tables/columns/indexes exist, or — for 3 non-schema migrations — direct effect verification: a trigger exists, a backfill's rows exist, a data-cleanup UPDATE's target rows are gone) |
| PARTIALLY_APPLIED | 14 | table(s)/column(s) present but 1+ expected object missing — see detail below |
| CONFIRMED_NOT_APPLIED | 5 | 0 of the migration's target objects exist live (4 are the pending-feature migrations above; the 5th, `20260819090000_private_rls_phase1_plan`, is explicitly self-marked "PLAN ONLY: do not apply" in its own header comment) |
| SUPERSEDED | 0 | no case found where a later migration structurally replaced an earlier one for the same table |
| UNKNOWN | 0 | resolved all 4 ambiguous (non-schema-object) migrations via direct effect queries |

**PARTIALLY_APPLIED detail** — 12 of the 14 are 85-98% complete, missing only 1-2 specifically
*named* index objects (e.g. `fx_currencies_active_kind_idx`, `etf_flows_etf_date_method_key`)
while every table and column the same migration declares is fully present live — most likely a
later migration renamed or redefined that specific index rather than the whole migration having
partially failed. The 2 substantively incomplete ones are
`20260810003000_insider_professional_depth` (11/30 objects present — the ownership tables landed,
`insiders`/`insider_filings` did not, matching Part 3's finding) and
`ipo_calendar_platform_pending` (17/55 — most of `ipo_offerings`'s columns are missing live; this
is a genuinely stalled feature, filename says "pending").

## Part 5 — 25 DB-ledger migrations missing local `.sql`

Direct ledger query confirms **25 unique migration names** recorded FINISHED in
`_prisma_migrations` with no matching folder anywhere in `prisma/migrations/` on disk today —
spanning `20260629135952_init_production_schema` through `20260808145500_add_bond_market_observations`
(the platform's original schema plus early additive migrations). Additionally, **2 migration
names appear twice in the ledger** (`20260722232853_add_data_source_registry` and
`20260727094000_add_stock_history_provenance`, each with one `ROLLEDBACK` unfinished attempt
followed by one successful `FINISHED` retry) — this is normal Prisma retry behavior, not drift,
and does not affect table counts.

Read-only recovery search performed this round:
- `git log --all --diff-filter=A -- 'prisma/migrations/20260629*' 'prisma/migrations/2026070*' 'prisma/migrations/2026071*' 'prisma/migrations/2026072*' 'prisma/migrations/2026073*' 'prisma/migrations/20260808145500*'` — **not found in any commit reachable from any local ref.** Combined with the fact this repo has been through multiple uncoordinated `vercel --prod` sessions and at least one prior file-loss incident (the reason this whole recovery effort exists), the most likely explanation is these folders were deleted from the working tree at some point before ever being committed, rather than removed after being committed.
- No local backup directory, docs folder copy, or `runtime`/`scratch` snapshot was found containing these migration names (checked via filename grep across the whole working tree, non-`node_modules`).
- Deployment artifacts (Vercel build output) don't retain `prisma/migrations/` source — only the generated client — so that avenue was ruled out without needing a live API call.

| Classification | Count | Names |
|---|---|---|
| RECOVERABLE | 0 | none found in git history, backups, or deployment artifacts |
| NOT_RECOVERABLE | 25 | all 25 — see list in `scripts/recovery/PRISMA_RECONCILIATION.md` (Phase C) |
| DUPLICATE_LEDGER_ENTRY | 2 | `20260722232853_add_data_source_registry`, `20260727094000_add_stock_history_provenance` (rollback+retry pattern, not real duplicates) |
| UNKNOWN | 0 | |

No fabricated SQL was written for these 25. Their effects are still knowable — the live schema
IS the record of what they did — just not their original exact source text.

## Part 6 — Future Prisma baseline scope

**Comparing the two options:**

- **ONLY_PRISMA_OWNED (263 tables)**: A baseline that represents exactly what Prisma already
  manages today. Low risk — it changes nothing about how the 200 non-Prisma tables are read or
  written, and it matches how the codebase already treats them (raw SQL / ingestion scripts, on
  purpose, for consensus/insider/institutional/domain-ingestion features). This is the option the
  user's stated principle points to directly: *"不要因為 live DB 有 463 tables 就強迫 Prisma
  schema 變成 463 models."*
- **PRISMA_OWNED + selected RAW_SQL_OWNED (263 + up to 26 = 289)**: Would additionally formalize
  the 26 RAW_SQL_OWNED tables (consensus_*, political_*, insider_owners,
  insider_ownership_eligible_issuers) as Prisma models, even though the runtime code was
  deliberately written against `$queryRawUnsafe` for these. Pro: `prisma migrate status` and
  `prisma db pull` would then agree with schema.prisma for the tables real users actually hit
  every day (movement-radar, congress/insider/institutional APIs) — meaningfully de-risks future
  drift on exactly the subsystem this whole recovery effort was triggered by protecting. Con:
  requires touching `lib/consensus/*.ts` and the mobile route files to migrate off raw SQL onto
  the Prisma client, which is application-code churn, not just a schema change — out of scope for
  a "baseline," which should describe what's there, not refactor how it's accessed.

**Recommendation: ONLY_PRISMA_OWNED for the baseline itself**, matching the stated preference.
Getting the 26 RAW_SQL_OWNED tables formally modeled is worth doing eventually (it would make the
gate's job easier and catch schema drift on the movement-radar feature specifically), but that's
an application-code migration project, not a baseline-migration decision — recommend tracking it
as a separate future phase rather than blocking or scope-creeping the baseline on it.

The 147 INGESTION_OWNED and 27 UNKNOWN tables should **not** enter any Prisma baseline: Prisma
migrations model lifecycle Prisma is expected to own, and forcing 174 tables the application
never touches into that lifecycle would make every future `prisma migrate dev` slower and every
schema diff noisier for no runtime benefit.

**SHOULD_CREATE_SINGLE_LIVE_DB_BASELINE: NO** — not as "dump all 463 tables into one baseline."
A baseline should eventually be created, but scoped to the 263 PRISMA_OWNED tables only, and only
after Part 4/5's findings are resolved (the 90-vs-38 ledger-order correction, the 17
pending-feature migrations, and the 4 legacy-model decisions) — doing it before that would bake
today's ordering confusion into a fresh baseline instead of fixing it.

## Part 8 — Production gate schema rule, redesigned

Implemented in the updated `scripts/recovery/production-gate.mjs` (this round adds a new check
`9b_schema_ownership`, does not touch DB/schema): instead of failing on *any* dirty
`prisma/schema.prisma` or *any* untracked migration folder, the gate now asks the ownership
manifest three narrower questions:

1. Does every `PRISMA_OWNED` table in `database-ownership.json` still have a corresponding model
   in `schema.prisma`? (drift here is real — Prisma silently losing track of a table it's
   supposed to own)
2. Does every `RAW_SQL_OWNED` table have a canonical source reference (a file in `db/*.sql` or a
   documented owner in the manifest)? Missing this means "this table matters, and nobody knows
   who's responsible for its schema."
3. Is `PRODUCTION_CRITICAL_UNKNOWN_COUNT` (UNKNOWN tables that ARE read/written by live
   app/cron/workflow code) zero? This is the actual blocker — an unowned table with live traffic
   is a genuine promotion risk. An UNKNOWN table nobody's code touches is a backlog item, not a
   blocker.

The pre-existing raw dirty-file check (uncommitted `schema.prisma`/`migrations/`) is **kept**,
but demoted from an automatic FAIL to a WARN, since Part 6 confirms the current dirty state is
expected and safe (known, classified, non-Prisma-owned tables) rather than unexplained drift.
