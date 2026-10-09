CREATE TABLE IF NOT EXISTS "mortgage_rate_observations" (
  "id" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "metric_code" TEXT NOT NULL,
  "mortgage_type" TEXT NOT NULL,
  "rate_type" TEXT NOT NULL,
  "fixing_period" TEXT,
  "maturity" TEXT,
  "observation_date" DATE NOT NULL,
  "rate" DECIMAL(18,8) NOT NULL,
  "unit" TEXT NOT NULL,
  "currency" TEXT,
  "frequency" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "source_record_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mortgage_rate_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mortgage_rate_observations_country_metric_code_observat_key"
  ON "mortgage_rate_observations"("country", "metric_code", "observation_date", "source");
CREATE INDEX IF NOT EXISTS "mortgage_rate_observations_country_observation_date_idx"
  ON "mortgage_rate_observations"("country", "observation_date");
CREATE INDEX IF NOT EXISTS "mortgage_rate_observations_metric_code_observation_date_idx"
  ON "mortgage_rate_observations"("metric_code", "observation_date");
