# Production migration ledger reconciliation — 2026-08-10

This artifact is a forensic approval package. No DDL, deploy, resolve, data rebuild, or website change was performed by this task.

## Census

- Observable migration writers: 0 (elevated Win32 command-line census)
- Production ledger: 48 rows / 45 distinct names
- Repository migrations: 82
- Matched: 13
- DB-only: 25
- Local-only: 62
- Checksum mismatch: 7
- Duplicate ledger names: 3
- Active failed: 0
- Rolled-back forensic rows: 3

## Matched

`20260805000000_add_global_index_platform`, `20260805090000_global_crypto_platform`, `20260810003000_global_index_constituents_p0`, `20260810033000_index_constituent_mapping_provenance`, `20260810100000_global_options_p0_depth`, `20260810130000_global_analyst_estimates_p0_depth_recovery`, `20260810143000_analyst_guidance_actual_link_v2`, `20260810210000_global_etf_flows_p0_depth_recovery`, `20260810210000_global_share_buyback_p0_depth_recovery`, `20260810223000_global_share_buyback_program_semantics_v2`, `20260810230000_global_insider_ownership_p0_depth_recovery`, `20260810233000_global_insider_ownership_beneficial_proxy_denominator_v2`, `20260811013000_etf_distribution_events_additive`.

## DB-only — restore authoritative artifacts; do not manufacture

`20260629135952_init_production_schema`, `20260705054545_add_asset_layer`, `20260705100600_add_investor_questionnaire`, `20260705142315_verify_investor_questionnaire`, `20260710100000_add_asset_etf_bridge_fields`, `20260710120000_add_provider_log_success_fail_counts`, `20260710140000_add_economic_indicator_and_data_provenance`, `20260710150000_add_provider_log_skipped_and_version`, `20260710160000_widen_economic_indicator_decimal_precision`, `20260711000000_add_economic_series_and_value`, `20260711010000_add_series_tag`, `20260712030000_add_fund_nav_date_source`, `20260712080000_add_market_master`, `20260712081750_add_market_master_sector_field`, `20260712230000_add_stock_platform`, `20260713140000_add_stock_backfill_flag`, `20260722232853_add_data_source_registry`, `20260725190000_add_favorites`, `20260726000000_add_economic_value_lineage`, `20260726150500_add_market_index_history`, `20260727043000_add_product_coverage_snapshot`, `20260727094000_add_stock_history_provenance`, `20260727095500_add_stock_history_import_metadata`, `20260731103000_add_priority_universe`, `20260808145500_add_bond_market_observations`.

Production checksum is known for every item, but SQL is absent from both the working repository and reachable Git history. Action: `RESTORE_HISTORICAL_MIGRATION_ARTIFACT` from the authoritative production release artifact and verify SHA-256. Until then these remain manual-review/physical-operation unknown.

## Checksum mismatch — semantic equivalent EOL drift

The seven Production checksums exactly match the committed Git blobs. The working-tree bytes differ because checkout uses CRLF; `git diff` reports no semantic change. Do not edit migration SQL. Add a separately approved `.gitattributes` policy for `prisma/migrations/**/migration.sql text eol=lf`, re-checkout safely, and confirm hashes.

- `20260729090000_add_production_scheduler_state`
- `20260729093000_add_daily_engine_lifecycle`
- `20260729100000_add_daily_completion_policy`
- `20260729110000_add_historical_market_lifecycle`
- `20260729120000_add_provider_symbol_mapping_registry`
- `20260730090000_add_stock_financial_facts`
- `20260801090000_exchange_aware_daily_scheduler`

Classification: `SEMANTICALLY_EQUIVALENT`; historical semantic mutation count 0.

## Duplicate-name truth

These each contain one preserved rolled-back row followed by one finished row: `20260722232853_add_data_source_registry`, `20260727094000_add_stock_history_provenance`, `20260805090000_global_crypto_platform`. This is deterministic Prisma forensic lineage, not two active versions. Action: `NO_ACTION`.

## Local-only classification

- `SCHEMA_ALREADY_PRESENT` (43): physical objects for every parsed operation are present. These require exact type/default/constraint semantic review before any individual `migrate resolve --applied` approval; no bulk resolve is allowed.
- `GENUINELY_PENDING` (9): `20260805160000_global_etf_holdings`, `20260810011000_institutional_holdings_mapping_cross_portfolio_v2`, `20260810030000_global_ranking_engine_p0_depth_recovery`, `20260810090000_carbon_markets_p0_depth`, `20260810091500_sovereign_debt_v2_contract_cleanup`, `20260810120000_add_shipping_index_canonical_depth`, `20260810233000_global_watchlist_alert_p0_depth_recovery`, `20260811000000_global_money_supply_p0_depth_recovery`, `earnings_calendar_platform_pending`.
- `SUPERSEDED/PARTIAL` (9): earlier foundation migrations whose physical domains were later created or extended by newer applied migrations; each requires a per-migration forward lineage decision.
- `UNSAFE` (1): `20260810003000_insider_professional_depth`.
- `UNKNOWN` (0 among local artifacts).

Parsed local divergent DDL operations: 752 = 587 applied, 164 not applied, 1 partial, 0 conflicting by object-existence test, 0 parser unknown. Add 25 DB-only artifact placeholders as unknown physical operation sets: forensic aggregate 777 operations/placeholders, 25 unknown.

## Insider conflict

The pending `20260810003000_insider_professional_depth` expects `insider_issuer_relationships` with TEXT `insider_id`. Production already has the applied `20260810230000_global_insider_ownership_p0_depth_recovery` contract using UUID `owner_id`, plus the applied v2 denominator/proxy extension. The same-name relation is therefore semantically incompatible even though both designs are additive elsewhere.

Action: `UNSAFE_DO_NOT_TOUCH` for the pending historical migration. Create a separately reviewed forward migration and adapt the runner to the already-applied `insider_owners` / UUID relationship contract. Do not deploy or resolve the conflicting migration as-is.

## Asset readiness

- ETF Holdings: additive; prerequisite `etfs` exists; no physical name conflict; genuinely pending, but blocked by global history frontier.
- Ranking: additive and internally ordered; genuinely pending; blocked by global history frontier.
- Watchlist: additive; prerequisite `users` exists; genuinely pending; blocked by global history frontier.
- Shipping index: additive; genuinely pending; earlier shipping observations are already present; blocked by global history frontier.
- Earnings: additive; prerequisite `stocks` exists; genuinely pending; blocked by global history frontier.

## Drift

- Physical base tables: 324
- Physical-only relative to Prisma schema: 119
- Prisma-only: 45
- Migration-expected but physically absent relations: 53
- Generated client: stale (`node_modules/.prisma/client/schema.prisma` differs from current schema and predates it)

## Business-data regression sample

Read-only counts: stocks 80,944; ETFs 12,802; funds 12,037; crypto assets 19; FX pairs 528; global index registry 78; corporate actions 699; institutional holdings 9,156. This task performed no business-data mutation.

## Safe deploy frontier and exact bounded approval set

`SAFE_DEPLOY_FRONTIER = NONE` and `NORMAL_PRISMA_DEPLOY_SAFE = NO`.

Required approvals, in order:

1. Restore the 25 DB-only historical migration artifacts from an authoritative production release, with each file matching its ledger SHA-256 exactly.
2. Approve repository EOL enforcement for migration SQL (`LF`) and a non-destructive re-checkout of the seven checksum-equivalent files.
3. Approve per-migration semantic verification of the 43 schema-present local-only migrations; only 100% exact candidates may receive individual `migrate resolve --applied` commands.
4. Approve manual lineage decisions/forward repairs for the nine superseded/partial migrations.
5. Approve a forward Insider repair that targets the already-applied UUID `insider_owners` contract; retire the conflicting pending migration from the deploy path without rewriting Production history.
6. Re-run ledger, checksum, physical-schema, generated-client, and business-count gates. No deploy until every unknown is zero and the frontier is deterministic.

No resolve commands are approved by this artifact. No normal migration is currently eligible for deployment from this repository state.

## Phase 1 partial-approval execution update

- Added and staged `.gitattributes` rule: `prisma/migrations/**/migration.sql text eol=lf`.
- Restored the seven checksum-equivalent files from their individually verified historical Git commits.
- Worktree SHA-256 now matches Production ledger: 7/7.
- Authoritative DB-only artifacts restored: 0/25. They are absent from master, origin/master, the remote bond branch, tags, reflog, and reachable/unreachable Git history. Reverse-generating SQL from physical schema is forbidden and was not attempted.
- Production mutation by this task: none.
- Business counts remained unchanged: stocks 80,944; ETFs 12,802; funds 12,037; crypto assets 19; FX pairs 528; index registry 78; corporate actions 699; institutional holdings 9,156.
- During final re-census, an external concurrent task changed repository migrations from 82 to 87 and Production ledger from 48 rows/45 names to 52 rows/49 names. Newly finished Production entries observed: `20260810110000_global_share_buyback_core_closeout_v3`, `20260810160000_analyst_guidance_closeout_v3`, `20260810161000_analyst_guidance_closeout_v3_freshness`, `20260810234500_global_insider_ownership_core_readiness_closeout_v3`.
- Current writer census after those changes: 0, but the original frozen snapshot was invalidated. The prior 43-item schema-present result cannot be promoted to a final exact gate without a new stable-snapshot audit.
- Current re-census: repository 87; ledger 52 rows/49 names; matched 24; checksum mismatch 0; DB-only 25; local-only 63; active failed 0.
- Insider remains `DO_NOT_TOUCH_FORWARD_REPAIR_REQUIRED`; the newly applied v3 closeout further confirms that the older pending TEXT-insider contract must not be replayed.
- Global migration frontier remains closed.
