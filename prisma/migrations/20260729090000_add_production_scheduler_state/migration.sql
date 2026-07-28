CREATE TABLE "production_scheduler_runs" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "exchange" TEXT NOT NULL,
  "run_type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ,
  "attempted" INTEGER NOT NULL DEFAULT 0,
  "completed" INTEGER NOT NULL DEFAULT 0,
  "inserted" INTEGER NOT NULL DEFAULT 0,
  "updated" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "details" JSONB,
  "error" TEXT,
  CONSTRAINT "production_scheduler_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "production_scheduler_runs_job_id_started_at_idx"
  ON "production_scheduler_runs"("job_id", "started_at");

CREATE TABLE "production_scheduler_locks" (
  "job_id" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "production_scheduler_locks_pkey" PRIMARY KEY ("job_id")
);

CREATE TABLE "production_scheduler_failures" (
  "job_id" TEXT NOT NULL,
  "stock_id" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "last_error" TEXT NOT NULL,
  "last_attempted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "production_scheduler_failures_pkey" PRIMARY KEY ("job_id", "stock_id")
);

CREATE INDEX "production_scheduler_failures_job_id_idx"
  ON "production_scheduler_failures"("job_id");
