# US Treasury Individual Bond V1 Production Runbook

## Scope and isolation

- Service: `smartfund-bond-us-treasury`
- Owner: `railway-bond-production`
- Assignment: `BOND / US_TREASURY / INCREMENTAL`
- Job ID: `official-bond-us-treasury-incremental`
- Schedule: `30 23 * * 1-5` (UTC), once after the U.S. business day rather than a five-minute full scan.
- Writes: existing `securities` identity rows plus production lifecycle/checkpoint/failure tables. Bond terms/events remain in the durable archive pending an approved schema migration.
- Excluded: all stock, ETF, fund, macro and existing Railway production jobs.

The dedicated service uses `Dockerfile.bond` and `railway.bond.toml`. It never runs `prisma migrate deploy`.

## Required environment variables

- `DATABASE_URL`: production pooled database URL or a Railway reference variable.
- `DIRECT_URL`: production direct database URL or a Railway reference variable.
- `SMARTFUND_NODE_ID=railway-bond-production`
- `BOND_LIVE_WRITE_AUTHORIZED=true`
- `BOND_RUNTIME_ROOT=/data/runtime/bond/us-treasury`
- `BOND_ARCHIVE_ROOT=/data/archive`
- `BOND_ARCHIVE_PREFIX=bond/us-treasury/v1`
- `BOND_MAX_UNIVERSE=1000`

No credential is stored in source control. `/data` must be a Railway volume mounted only on the Bond service.

## Execution gates

1. Registry validates a unique incremental owner.
2. Dry-run reports `databaseWrites=0`, `lifecycleWrites=0`, `crossDomainWrites=0`.
3. The database has no valid `official-bond-us-treasury-incremental` lock or active lifecycle.
4. The wrapper acquires the market/job-scoped lifecycle lock.
5. The importer runs a bounded full eligible universe (currently 465, hard ceiling 1,000).
6. Progress is persisted every 100 securities and the lock heartbeat is extended every 60 seconds.
7. Item failures are queued and do not stop the batch.
8. Raw and normalized artifacts are written content-addressably to the volume, then checksum-replayed.
9. Completion requires archive replay `PASS` and zero cross-domain writes.

## Archive convention

Root: `${BOND_ARCHIVE_ROOT}/${BOND_ARCHIVE_PREFIX}`

- `objects/sha256/<prefix>/<hash>.bin`: immutable content-addressed bytes.
- `indexes/<logical-path-hash>.json`: logical current pointer and all prior versions.
- `manifests/<run-id>.json`: run manifest with checksum, source dates, parser version and superseded relation.
- `manifests/<run-id>.json.sha256`: manifest checksum.

Duplicate bytes reuse the existing object. A changed logical document records the prior content hash. Replay verifies manifest checksum, object checksum, byte length and JSON parsing.

## Failure, retry and resume

- Local durable queue: `${BOND_RUNTIME_ROOT}/official-bond-us-treasury-incremental-failures.json`.
- Production queue: `production_scheduler_failures`, keyed by job ID and official security ID.
- Checkpoint: both the Railway volume JSON checkpoint and `production_scheduler_checkpoints`.
- A resolved retry is retained as resolved; it is not deleted.
- A stale lifecycle may be recovered only after the job lock is absent/expired and the ten-minute stale rule is satisfied.

## Rollback

1. Disable the dedicated Bond cron schedule or roll back only the Bond service deployment.
2. Do not stop or redeploy `smartfund-v2` and do not alter Worker-02.
3. Do not delete the volume, lifecycle checkpoint, failure queue, completed `securities` rows or valid active lock.
4. If a run is active, allow it to exit or wait for the existing stale-lock rule; never force-delete a healthy lock.
5. Re-enable the prior verified Bond deployment after ownership, archive replay and checkpoint checks pass.

Because writes are idempotent and the archive is content-addressed, restarting from the retained checkpoint does not duplicate completed records.
