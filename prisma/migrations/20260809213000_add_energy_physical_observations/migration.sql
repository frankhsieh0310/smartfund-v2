CREATE TABLE IF NOT EXISTS "energy_physical_observations" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "commodity" TEXT NOT NULL,
    "metric_code" TEXT NOT NULL,
    "metric_name" TEXT NOT NULL,
    "observation_date" DATE NOT NULL,
    "period_start" DATE,
    "period_end" DATE,
    "value" DECIMAL(30,8) NOT NULL,
    "unit" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "flow_direction" TEXT,
    "facility_type" TEXT,
    "source" TEXT NOT NULL,
    "source_record_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "energy_physical_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "energy_physical_observations_identity_key"
ON "energy_physical_observations"("country", "commodity", "metric_code", "observation_date", "source");

CREATE INDEX IF NOT EXISTS "energy_physical_observations_country_commodity_date_idx"
ON "energy_physical_observations"("country", "commodity", "observation_date");

CREATE INDEX IF NOT EXISTS "energy_physical_observations_metric_date_idx"
ON "energy_physical_observations"("metric_code", "observation_date");
