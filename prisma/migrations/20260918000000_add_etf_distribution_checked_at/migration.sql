-- Minimal persistent "checked, no distribution found" marker for the ETF distribution backfill.
-- Additive only, idempotent. Lets the backfill candidate query permanently exclude an ETF once
-- it's been confirmed to have no distribution events, instead of re-scanning it every session.
ALTER TABLE "etfs"
  ADD COLUMN IF NOT EXISTS "distribution_checked_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "etfs_distribution_checked_at_idx"
  ON "etfs"("distribution_checked_at");
