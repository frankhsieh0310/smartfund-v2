ALTER TABLE "production_scheduler_failures"
  ADD COLUMN "classification" TEXT NOT NULL DEFAULT 'RETRYABLE_FAILURE',
  ADD COLUMN "resolved" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "resolution_reason" TEXT;

ALTER TABLE "production_scheduler_runs"
  ADD COLUMN "success_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "no_update_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "permanent_unavailable_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "retryable_failure_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "exit_code" INTEGER;
