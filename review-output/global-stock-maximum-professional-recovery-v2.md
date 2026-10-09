# Global Stock Maximum Professional Recovery V2

Generated: 2026-08-10T13:18:08.652Z

## Verdict

- Status: `PARTIAL_PRODUCTION`
- Historical baseline protected: `118,468,749` rows
- Canonical stock universe: `80,944`
- No DDL, migration, deployment, destructive history rewrite, or cross-asset write was performed.

## Completed recovery

- Lifecycle audit is deterministic across OS process identity, scheduler lock, run, checkpoint, and job-specific advisory locks.
- Sixteen blank-name identities are fully classified: 15 `SOURCE_CONSTRAINED_NAME_NOT_PROVIDED`; 1 `IDENTITY_CONFLICT_PARSER_ARTIFACT`; no guessed names and no database identity write.
- JPX authoritative database checkpoint superseded the stale local checkpoint. A one-symbol canary resumed from `5952`, classified `597A@F` as `YAHOO_INSUFFICIENT_HISTORY:1`, advanced the failure ledger, and released its lock normally.
- JPX standalone runner is detached as PID `35396`, starting from `597A@F`; it retains dry-run gating, stock-only validation, checkpoint/resume, bounded batches/retries, lock, heartbeat, failure queue, and completion manifest.
- NYSE price runner now has a true zero-write dry-run, insert-missing-only semantics, chunked writes, no destructive source deletion, and no conflict overwrite. Dry-run found no remaining price symbols after checkpoint `ZWS` (`2,610 / 2,241 / 369`).
- JPX and NYSE scoped Prisma clients are capped at one connection to avoid worsening Supavisor session-mode saturation.

## Preserved ownership

- Corporate Actions supervisor/worker: PID `50960` / `52904`, preserved.
- Share Buyback supervisor/worker: PID `45520` / `32348`, preserved.
- Market-event and other asset writers were not restarted, stopped, or modified.

## Explicit blockers / return conditions

- `official-financial-nyse-historical`: expired lock and orphan `IN_PROGRESS` run remain; direct cleanup was not applied because the environment rejected the mutation. Return only through approved lifecycle recovery with no active OS owner, advisory lock, or scheduler collision.
- Canonical bridge migration: blocked by 7 unknown migration lineages, one divergent duplicate, stale generated Prisma client, and absent `stocks.security_id`; no migration or DDL was attempted.
- Row-level full-history quality evidence remains `EVIDENCE_PENDING`; no expensive global `stock_history` scan was introduced.
- Identity enrichment for the 15 EBS records returns when an exact licensed/provider name is available; the parser artifact requires deterministic upstream exclusion, not fuzzy repair.

## Evidence

- `runtime/global-stock/maximum-professional-recovery-v2/lifecycle-audit.json`
- `runtime/global-stock/maximum-professional-recovery-v2/identity-provider-census.json`
- `runtime/automation/jpx-standalone/checkpoint.json`
- `runtime/automation/jpx-standalone/heartbeat.json`
- `runtime/automation/jpx-standalone/failure-queue.json`
- `runtime/automation/jpx-standalone/completion-manifest.json`
