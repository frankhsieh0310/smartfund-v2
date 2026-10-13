# Deploy Lock Protocol (design, Phase C — not yet enforced)

## Why this exists

Confirmed incident: multiple concurrent Claude Code sessions on this account each ran
`vercel --prod` from their own independent local working tree. Every session's CLI reports the
same generic actor string, so deployment history alone can't distinguish "one session deployed
twice" from "two sessions deployed once each" — the only way this was diagnosed was by cross-
referencing git refs and timestamps in `vercel ls` output. Whichever session deployed last won
the production alias, silently overwriting the other session's routes/cron/workflows. This is
what produced the 404s this recovery is repairing.

A local temp file (e.g. `.deploy.lock`) is not sufficient on its own: it isn't visible to a
session running from a different working-tree checkout, it isn't visible across machines, and
nothing stops a session from ignoring it or deleting it.

## Immediate (this phase): a documented protocol, human/session-readable

1. **`vercel.json` and this repo's `master` branch are the only source of truth for what is
   live.** No session may run `vercel --prod` / `vercel deploy --prod` / any production alias
   change directly from a feature or recovery branch.
2. **Single promotion path**: `<any branch>` → `npm run build` → `vercel deploy` (preview only)
   → `node scripts/recovery/production-gate.mjs --build-status PASS --deployment-id <dpl>` →
   only if `PRODUCTION_PROMOTION_ALLOWED: YES` → merge to `master` → promote **from `master`
   only**.
3. **Before starting any session that might deploy**, the session must:
   - Read this file.
   - Run `git log -1 --format=%H origin/master` and compare against the last known-good SHA
     recorded in `scripts/recovery/LAST_PROMOTED.json` (to be created at first real promotion —
     doesn't exist yet, this phase does not promote).
   - If another session's work is mid-flight (visible via `vercel ls` showing a very recent
     deployment not authored by this session, or an open PR against `master` touching
     `vercel.json`/`app/workflows/`/`app/api/cron/`), STOP and surface it to the user instead of
     deploying.

## Target end state (recommended next phase, not built yet)

Replace the honor-system protocol above with a mechanism no session can bypass by choice:

- **Vercel Git integration + branch deploy hooks**: disable direct `vercel --prod` for all
  contributors/CLIs on the project (Vercel project settings → Git → require deploys to originate
  from the connected Git provider). Vercel then only promotes commits that land on `master` via a
  merged PR — an individual CLI session physically cannot alias-swap production even if it tries.
- **CI gate as the only promotion path**: a GitHub Actions workflow on `master` that runs
  `npm run build` + `node scripts/recovery/production-gate.mjs`, and only on green does it call
  `vercel --prod` with a token scoped to CI, not to any interactive session.
- **Branch protection on `master`**: require PR review + the CI gate check before merge, so no
  session — interactive or automated — can push directly to `master` and trigger a promotion.

This closes the actual hole (any session with a Vercel token can `vercel --prod` from anywhere)
rather than adding a lock file that a determined or confused session can still step around.

## This phase's stance

`DIRECT_VERCEL_PROD_ALLOWED: NO` for every session until the Git-integration/CI gate above is
in place. This document is the interim enforcement mechanism — it is process, not code, and it
is weaker than the target state by design admission, not oversight.
