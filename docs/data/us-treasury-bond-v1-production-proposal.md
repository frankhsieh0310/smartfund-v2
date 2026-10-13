# U.S. Treasury Individual Bond V1 Production Proposal

Scope: `BOND / US_TREASURY / INCREMENTAL`, owned by `smartfund-master` until an explicit Railway handoff is approved.

## Production boundary

- Official source: U.S. Treasury Fiscal Data, Treasury Securities Auctions Data.
- Canonical identity: source namespace plus official security ID; CUSIP remains internal-only pending a separate redistribution review.
- Current database write: minimal identity rows in `securities` with `exchange = US_TREASURY`.
- Raw source pages, normalized terms, auction history, lifecycle events, and official latest auction observations remain in the per-run archive because production has no deployed individual-bond detail tables.
- This source does not provide secondary-market price history, bid/ask, daily YTM/YTW, spread, duration, or a tradable latest price. Those layers must not be inferred from government yield curves.

## Runner

```powershell
$env:SMARTFUND_NODE_ID="smartfund-master"
$env:BOND_LIVE_WRITE_AUTHORIZED="true"
node --experimental-strip-types --env-file=.env scripts/data/bond/import-us-treasury-v1.ts --incremental --apply --confirm-production-write --full-universe --confirm-full-universe
```

Dry-run uses the same command with `--dry-run` and without `--apply`, `--confirm-production-write`, or `BOND_LIVE_WRITE_AUTHORIZED`.

## Proposed schedule and gates

- Trigger: after the official dataset releases new or amended auction records; until an event feed is added, poll on U.S. business days with a non-overlapping bounded schedule.
- Ownership gate: `BOND / US_TREASURY / INCREMENTAL` must resolve to exactly one active owner.
- Lock gate: no valid `official-bond-us-treasury-incremental` production lock or running lifecycle.
- Archive gate: Railway deployment requires durable storage for raw and normalized per-run archives before handoff.
- Schema gate: keep using only the existing minimal `securities` mapping; do not deploy unsupported terms/latest fields without a separately approved migration.
- Retry: item failures are queued, checkpoint advances, and the batch continues; source-wide or integrity failures stop writes.
- Stale-lock recovery: use the existing production stale-lock policy only; never delete a valid lock manually.

## Deployment status

Proposal only. Railway scheduler, ownership, and deployment are unchanged.
