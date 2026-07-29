CREATE TABLE "production_market_lifecycles" (
  "market_id" TEXT NOT NULL,
  "exchange" TEXT NOT NULL,
  "historical_job_id" TEXT NOT NULL,
  "historical_status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
  "historical_run_id" TEXT,
  "historical_completed_at" TIMESTAMPTZ,
  "historical_summary" JSONB,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "production_market_lifecycles_pkey" PRIMARY KEY ("market_id")
);

CREATE UNIQUE INDEX "production_market_lifecycles_historical_job_id_key"
  ON "production_market_lifecycles"("historical_job_id");
