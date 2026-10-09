CREATE TABLE IF NOT EXISTS "energy_physical_series" (
  "id" TEXT PRIMARY KEY, "country" TEXT NOT NULL, "geography_level" TEXT NOT NULL,
  "geography_code" TEXT NOT NULL, "commodity" TEXT NOT NULL, "commodity_family" TEXT NOT NULL,
  "product" TEXT NOT NULL, "metric_code" TEXT NOT NULL, "metric_name" TEXT NOT NULL,
  "supply_demand_category" TEXT NOT NULL, "flow_direction" TEXT, "facility_type" TEXT,
  "frequency" TEXT NOT NULL, "unit" TEXT NOT NULL, "provider" TEXT NOT NULL,
  "source_series_id" TEXT NOT NULL UNIQUE, "source_url" TEXT NOT NULL, "status" TEXT NOT NULL,
  "start_date" DATE, "end_date" DATE, "measurement_basis" TEXT NOT NULL,
  "seasonal_adjustment" TEXT, "methodology_version" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "energy_physical_series_taxonomy_idx" ON "energy_physical_series"("country","commodity_family","metric_code");

ALTER TABLE "energy_physical_observations" ADD COLUMN IF NOT EXISTS "series_id" TEXT;
ALTER TABLE "energy_physical_observations" ADD COLUMN IF NOT EXISTS "source_url" TEXT;
ALTER TABLE "energy_physical_observations" ADD COLUMN IF NOT EXISTS "retrieved_at" TIMESTAMP(3);
ALTER TABLE "energy_physical_observations" ADD COLUMN IF NOT EXISTS "verification_state" TEXT;
ALTER TABLE "energy_physical_observations" ADD COLUMN IF NOT EXISTS "raw_checksum" TEXT;
ALTER TABLE "energy_physical_observations" ADD COLUMN IF NOT EXISTS "ingestion_version" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS "energy_physical_observations_series_date_key" ON "energy_physical_observations"("series_id","observation_date");
CREATE INDEX IF NOT EXISTS "energy_physical_observations_source_series_idx" ON "energy_physical_observations"("source_record_id","observation_date");

CREATE TABLE IF NOT EXISTS "energy_physical_revisions" (
  "id" TEXT PRIMARY KEY, "series_id" TEXT NOT NULL, "observation_date" DATE NOT NULL,
  "previous_value" DECIMAL(30,8) NOT NULL, "revised_value" DECIMAL(30,8) NOT NULL,
  "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "source_checksum" TEXT NOT NULL,
  "ingestion_version" INTEGER NOT NULL,
  UNIQUE("series_id","observation_date","ingestion_version")
);
CREATE INDEX IF NOT EXISTS "energy_physical_revisions_series_date_idx" ON "energy_physical_revisions"("series_id","observation_date");

CREATE TABLE IF NOT EXISTS "energy_physical_analytics" (
  "id" TEXT PRIMARY KEY, "series_id" TEXT NOT NULL, "observation_date" DATE NOT NULL,
  "analytic_code" TEXT NOT NULL, "value" DECIMAL(30,10) NOT NULL, "unit" TEXT NOT NULL,
  "formula_version" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("series_id","observation_date","analytic_code")
);
CREATE INDEX IF NOT EXISTS "energy_physical_analytics_code_date_idx" ON "energy_physical_analytics"("analytic_code","observation_date");

CREATE TABLE IF NOT EXISTS "energy_physical_coverage" (
  "series_id" TEXT PRIMARY KEY, "identity_ready" BOOLEAN NOT NULL, "current_ready" BOOLEAN NOT NULL,
  "history_ready" BOOLEAN NOT NULL, "history_depth_days" INTEGER NOT NULL, "taxonomy_ready" BOOLEAN NOT NULL,
  "analytics_ready" BOOLEAN NOT NULL, "provenance_ready" BOOLEAN NOT NULL, "freshness_state" TEXT NOT NULL,
  "revision_ready" BOOLEAN NOT NULL, "detail_ready" BOOLEAN NOT NULL, "observation_count" INTEGER NOT NULL,
  "earliest_date" DATE, "latest_date" DATE, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "energy_physical_coverage_freshness_detail_idx" ON "energy_physical_coverage"("freshness_state","detail_ready");
