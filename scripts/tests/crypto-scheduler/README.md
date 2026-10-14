# Crypto scheduler code-ready candidate

Base: existing `recovery/crypto-production` worktree, production commit `1dcba6f`.
No production deploy, scheduler activation, secret change, schema change or DB mutation is part of this change.

## Bounded work and cadence

- Quote: every 15 minutes, existing 240-second loop and 20-market provider batches; existing checkpoint body unchanged. At the observed 180 markets/invocation, an 8,209-market rotation takes about 11.5 hours, excluding GitHub queue delays. This is rolling coverage, not a 15-minute freshness promise for every asset.
- Marketcap: every 30 minutes, at most 250 markets/invocation, selected by active Yahoo market ID ascending. Only those symbols are requested from Yahoo quote, 50/request. Approximately 33 invocations / 16.5 hours per 8,209-market rotation, excluding queue delays.
- History: every two hours, existing 180-second loop and two-market batches. Existing candle/checkpoint implementation is preserved. No full-history run is launched.
- Existing shared GitHub Actions concurrency is unchanged; scheduled work may queue. Crypto is explicitly selectable via workflow_dispatch and is not implicitly added to the legacy `all` option.

## Continuation, dedupe, failure behavior

`production_scheduler_checkpoints.checkpoint_key = yahoo-crypto-marketcap` stores `last_symbol` as the last processed market ID. `id > cursor` works even if that row is deleted. New IDs behind the cursor are visited next rotation. One DB lookahead row is not sent to Yahoo; reaching the tail resets the cursor and reports wrapped=true.

Run key: `yahoo-crypto-marketcap:v2:invocation:<GitHub run_id>`. Re-running the same Actions run uses the same ID, including across time boundaries. Manual callers can supply the same `x-crypto-invocation-id` header for retries; without it, a fixed 30-minute slot is used. Quote uses the same strategy with a 15-minute fallback slot. History retains its existing hourly run key.

Existing scheduler leases serialize each phase for six minutes (greater than maxDuration=280). New legitimate invocations can resume after an abandoned lease expires; no lock cleanup process is needed. Source HTTP/authentication/envelope failures preserve the cursor. Missing/invalid individual symbols are recorded in run details and advance, to avoid poisoning a rotation; they are revisited next rotation. This includes an all-missing, structurally valid provider response, which becomes PARTIAL with explicit per-symbol failures.

Yahoo observation timestamps, a forward-only Yahoo source guard, and ON CONFLICT DO NOTHING prevent duplicate writes and avoid overwriting another provider on a timestamp collision. Canonical inserts, checkpoint advance, and successful/partial run finalization commit atomically. Fatal provider errors return 500; GitHub also checks failedMarkets on 200 responses.

## Verification

From the worktree root: `node scripts/tests/crypto-scheduler/test-crypto-scheduler.cjs`.

The tests execute the real marketcap module with an in-memory DB/provider double: A/B continuation, duplicate/concurrent invocation, next slice, exact tail, deleted cursor, missing symbols, insertion behind cursor, stale observation, rollback and lease protection. The fixtures verify quote/history checkpoint bodies and all pre-existing workflow steps/cadences remain unchanged. These are offline tests, not production DB integration tests.

Targeted TypeScript checking covers only the three Crypto modules and their imported dependencies. The Yahoo source was separately probed read-only with two symbols, including one outside the old screener first page.

## Future activation gate

First deploy the reviewed Crypto route/modules; then put the scheduler definition on the GitHub default branch. Do not enable the new scheduler against the old fixed-first-page route. Retain SMARTFUND_CRON_SECRET/CRON_SECRET and the existing shared workflow. Activation and live bounded verification are intentionally deferred; this candidate does not publish or activate anything.
