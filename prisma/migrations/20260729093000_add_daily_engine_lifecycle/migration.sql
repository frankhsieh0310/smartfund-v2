ALTER TABLE "production_scheduler_runs"
  ADD COLUMN "universe_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "latest_trading_date" TIMESTAMPTZ,
  ADD COLUMN "validation_status" TEXT,
  ADD COLUMN "validation_details" JSONB;

ALTER TABLE "production_scheduler_failures"
  ADD COLUMN "error_type" TEXT NOT NULL DEFAULT 'UNKNOWN_ERROR',
  ADD COLUMN "next_retry_at" TIMESTAMPTZ,
  ADD COLUMN "resolved_at" TIMESTAMPTZ;

CREATE TABLE "production_scheduler_checkpoints" (
  "job_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "last_symbol" TEXT,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "succeeded" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "production_scheduler_checkpoints_pkey" PRIMARY KEY ("job_id")
);

CREATE INDEX "production_scheduler_failures_next_retry_at_idx"
  ON "production_scheduler_failures"("job_id", "next_retry_at");
