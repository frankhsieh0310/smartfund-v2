ALTER TABLE "production_scheduler_runs"
  ADD COLUMN IF NOT EXISTS "target_trade_date" DATE,
  ADD COLUMN IF NOT EXISTS "expected_trading_date" DATE,
  ADD COLUMN IF NOT EXISTS "provider_latest_date" DATE,
  ADD COLUMN IF NOT EXISTS "run_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "production_scheduler_runs_run_key_key"
  ON "production_scheduler_runs"("run_key")
  WHERE "run_key" IS NOT NULL;

ALTER TABLE "production_scheduler_checkpoints"
  ADD COLUMN IF NOT EXISTS "checkpoint_key" TEXT,
  ADD COLUMN IF NOT EXISTS "target_trade_date" DATE,
  ADD COLUMN IF NOT EXISTS "run_type" TEXT;

UPDATE "production_scheduler_checkpoints"
SET "checkpoint_key" = "job_id" || ':LEGACY'
WHERE "checkpoint_key" IS NULL;

ALTER TABLE "production_scheduler_checkpoints"
  ALTER COLUMN "checkpoint_key" SET NOT NULL;

ALTER TABLE "production_scheduler_checkpoints"
  DROP CONSTRAINT IF EXISTS "production_scheduler_checkpoints_pkey";

ALTER TABLE "production_scheduler_checkpoints"
  ADD CONSTRAINT "production_scheduler_checkpoints_pkey" PRIMARY KEY ("checkpoint_key");

CREATE UNIQUE INDEX IF NOT EXISTS "production_scheduler_checkpoints_market_date_type_key"
  ON "production_scheduler_checkpoints"("job_id", "target_trade_date", "run_type")
  WHERE "target_trade_date" IS NOT NULL AND "run_type" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "production_scheduler_checkpoints_job_updated_idx"
  ON "production_scheduler_checkpoints"("job_id", "updated_at");

ALTER TABLE "production_scheduler_failures"
  ADD COLUMN IF NOT EXISTS "target_trade_date" DATE,
  ADD COLUMN IF NOT EXISTS "provider_latest_date" DATE,
  ADD COLUMN IF NOT EXISTS "first_failed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "last_http_status" INTEGER,
  ADD COLUMN IF NOT EXISTS "raw_response_path" TEXT;

CREATE INDEX IF NOT EXISTS "production_scheduler_failures_market_date_idx"
  ON "production_scheduler_failures"("job_id", "target_trade_date", "next_retry_at");
