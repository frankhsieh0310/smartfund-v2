CREATE TABLE IF NOT EXISTS "treasury_fiscal_observations" (
  "id" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "metric_code" TEXT NOT NULL,
  "metric_name" TEXT NOT NULL,
  "official_field" TEXT NOT NULL,
  "observation_date" DATE NOT NULL,
  "period_start" DATE,
  "period_end" DATE,
  "value" DECIMAL(30,2) NOT NULL,
  "unit" TEXT NOT NULL,
  "currency" TEXT,
  "frequency" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "source_record_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "treasury_fiscal_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "treasury_fiscal_observations_identity" UNIQUE ("country", "metric_code", "observation_date", "source")
);

CREATE INDEX IF NOT EXISTS "treasury_fiscal_observations_country_date_idx"
  ON "treasury_fiscal_observations" ("country", "observation_date");
