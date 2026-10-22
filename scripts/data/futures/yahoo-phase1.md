# Yahoo Futures HEAD mapping finalization

Scope: the existing 35 clean HEAD symbols. History uses the existing
`futures_root_market_observations` and `(yahoo_symbol, observed_date)` key.
The 451 month records remain metadata proposals in the manifest; their metadata write
entry point is now deferred. Month history and news are disabled.

## Reconciliation evidence and policy

The legacy `run-yahoo-global-history.ts` and `run-yahoo-full-universe.ts` write Yahoo
Chart 1d responses directly. `VENDOR_CONTINUOUS_ROOT_SERIES` is a storage label;
it is not proof of back-adjustment. Keep that label for newly inserted HEAD bars and
preserve the grain of existing rows. The older local Phase1 label is accepted as the
same Yahoo HEAD identity, not used to create a second series.

For the 32 existing HEADs, look up the provider mapping FIRST and retain its root ID.
Normalize CMX/COMEX, NYM/NYMEX, CBT/CBOT and NYB/ICE for identity comparison only.
Retain existing Treasury classification INTEREST_RATE_FUTURES and other canonical
classification. Do not overwrite canonical roots, mapping exchange/category, active
contract mapping or legacy evidence. Add provider facts under the
`field_disposition.yahooPhase1Provider` namespace. No phase1 flag is required to reuse.
Unknown or mismatched identities fail closed rather than creating replacement roots.

BZ=F was independently checked read-only: canonical root
`7ceb9102-ff27-4040-a181-26aaabbd6193`, root BZ, source YAHOO_FINANCE,
exchange ICE, class ENERGY_FUTURES; its mapping URL targets the exact Yahoo BZ=F
chart and its 4,740 history rows have source YAHOO, with zero linked month contracts.
The legacy writer hardcodes ICE; cached Yahoo metadata reports NYM / NY Mercantile,
FUTURE, Brent Crude Oil Last Day Financial Futures. Reuse that exact canonical ID
for this provider series; preserve ICE canonically and record NYM as provider metadata.
This is a reviewed exception, not a general ICE=NYM venue alias. If its expected
identity changes, quarantine only BZ and continue other HEADs without fetching BZ.

Only MGC=F, SIL=F and B0=F are approved TRUE_NEW. Before a future write, recheck
for an existing root; any possible equivalent requires review. No root was created
in production during this task.

## History behavior

- At most 3 Yahoo requests per invocation; default 7-day window, hard maximum 31.
- Explicit start/end, end exclusive, closed UTC days only; no range=max request.
- Incremental mode re-fetches 3 days before latest saved date, bounded by start.
- Persist both symbol and date cursor; same invocation ID dedupes, a new ID resumes.
- Upsert the same Yahoo symbol/date. A later request-start retrieved_at can update
  OHLCV; an older/equal timestamp cannot replace newer bars. Existing grain and root
  are preserved. Different source/root or an unrecognized grain is rejected.
- Reject regressions in Yahoo market timestamp. Fetch pool concurrency defaults to 2
  (hard maximum 2), with sequential windows within each symbol and at most 3 requests
  total. Database operations stay sequential on one locked transaction/connection.
- Each failed window rolls back to a savepoint; quarantine that symbol and retain
  its unprocessed gap/reason in scheduler-run details. Other symbols continue.
  Checkpoint completion means the queue was traversed, not that quarantined gaps
  were filled. Retry quarantined gaps explicitly after resolving their cause.
- Incremental and backfill use the same worker. Keep the market symbol list and
  date bounds stable while resuming with new invocation IDs until done. No per-symbol
  scheduler exists. Daily runs use a new end date and latest-date short overlap.
- Live screener pagination and snapshot collection are not implemented here; the
  metadata entry reads the saved manifest. Bulk capability is not ingestion readiness.
- Share the legacy Yahoo writer advisory transaction lock in addition to the new
  phase checkpoint lock, preventing concurrent legacy/new writer updates.

## Execution gate and verification

`node scripts/data/futures/yahoo-phase1.mjs plan` is read-only.
Write CLI commands remain local-only, require `YAHOO_FUTURES_LOCAL_DATABASE_URL`
and the repository Prisma dependency. No production endpoint, deployment, migration,
scheduler or production write is enabled. `metadata-months` refuses execution.

`node scripts/tests/yahoo-futures-phase1/test.mjs` uses PGlite and saved fixtures.
Set PGLITE_MODULE to an external installation of @electric-sql/pglite if needed;
repository dependency files are unchanged. Tests write only a disposable in-memory
Postgres engine. They seed legacy mappings and verify all 32 IDs/roots stay unchanged,
alias/class normalization, missing-phase1 reuse, three TRUE_NEW identities, BZ reuse
and isolated quarantine, existing-grain upserts, overlap revision, stale guards,
checkpoint/resume and idempotent rerun. No live Yahoo request is made by tests.


## Phase 1 completion contract (2026-09-15)

COMPLETE requires both verified initial history coverage and proven unattended live
sync. A traversed queue or MAX(observed_date) alone is never completeness evidence.
MGC and SIL backfill remain independent of live updates; existing checkpoint keys
are unchanged. runLiveHistory uses the same engine with incremental mode and a
stable seven-day cycle bound. Each new cycle resumes across invocations (3 requests
maximum, 2 symbols concurrently). Backfill uses separate mode/bounds keys.

Live source state is the actual validated Yahoo 1d response, not a calendar-based
expectation. Compare source dates and OHLCV at existing NUMERIC(24,8) precision to
canonical rows; write only new/changed rows. Equal source rows are NOOP, empty rows
are SOURCE_NO_DATA. Checkpoint and observation metadata may still be recorded on
NOOP. Short overlap catches revisions; canonical/source/grain and stale guards
remain active. Calendar end only excludes the unclosed UTC day.

Failure repair reads a specific existing scheduler run's failed subset. Only typed
FETCH_ERROR/PARSE_ERROR/WRITE_ERROR/IDENTITY_ERROR/LAGGING are eligible; no success
symbols or original checkpoints are reset. Repair is explicitly invoked, bounded,
and deduped, with no infinite retry loop. CC/KC/OJ are excluded from live fetching
as DATA_QUALITY_QUARANTINED; no OHLCV validation is relaxed.

Health is emitted in existing production_scheduler_runs.details.health, with
SOURCE, SOURCE_LATEST, DB_LATEST, LAG (calendar-day distance, not session count),
COMPLETE, INCOMPLETE, FAILED, NO_DATA, LAST_SUCCESS, NEXT_CHECK, AUTO_SYNC and
BACKFILL_STATUS. The shared API/dashboard health adapter is NOT connected yet.
The existing web freshness helper is calendar/age based and must not be used to
invent Yahoo publication state. AUTO_SYNC remains false and NEXT_CHECK null until
one verified production scheduler owner supplies actual execution evidence.

Source: Yahoo only. Existing legacy run-yahoo-full-universe.ts already has screener
bulk collection at count=250 and four pages (start=0,250,500,750), plus current
snapshot persistence. This is 4 requests for up to 1000 rows, not proof of complete
904-symbol coverage: source rows can move or be missing. Its cycle also couples
schema execution, canonical remapping, full-range history and a five-minute local
loop. Do not invoke/import that side-effectful launcher to enable Phase 1. Reuse
its endpoint/pagination and existing snapshot table only after isolating a bounded
collector that preserves approved mappings; metadata/snapshot integration is still
a production gap, not a reason to block incremental history implementation.

Canonical path: futures_root_market_observations plus futures_product_roots and
futures_yahoo_symbol_mappings; snapshots use futures_yahoo_current_snapshots.
No dedicated canonical Futures shared API adapter was found in the scoped API /
data-platform search. JSON manifest is only the approved allowlist, not live prices.
Legacy local JSON queues are not an authoritative live serving source.

Deployment/ownership gap: Phase 1 has no configured cloud route/scheduler owner in
the checked cloud-data-ingestion workflow / cron routes. No matching local Yahoo
Futures Node worker was observed during this check. No process was stopped or
started. Local worker capability is not production AUTO_SYNC readiness.

Authoritative Git gap: Phase1 worker, manifest, legacy launcher and associated
Phase1 tests/docs are local/untracked. Required source/config/entry/workflow must
be committed, reviewed and released through authoritative Git before production
completion can be asserted. This task does not commit, push, deploy, activate a
scheduler, rewrite canonical mappings, or fetch live Yahoo data.
