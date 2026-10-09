CREATE TABLE IF NOT EXISTS "sovereign_debt_observations" (
  "id" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "metric_code" TEXT NOT NULL,
  "metric_name" TEXT NOT NULL,
  "observation_date" DATE NOT NULL,
  "period_start" DATE,
  "period_end" DATE,
  "value" DECIMAL(30,2) NOT NULL,
  "unit" TEXT NOT NULL,
  "currency" TEXT,
  "frequency" TEXT NOT NULL,
  "debt_definition" TEXT NOT NULL,
  "sector_definition" TEXT,
  "source" TEXT NOT NULL,
  "source_record_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sovereign_debt_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sovereign_debt_observations_country_metric_code_observ_key"
  ON "sovereign_debt_observations"("country", "metric_code", "observation_date", "source");
CREATE INDEX IF NOT EXISTS "sovereign_debt_observations_country_observation_date_idx"
  ON "sovereign_debt_observations"("country", "observation_date");
