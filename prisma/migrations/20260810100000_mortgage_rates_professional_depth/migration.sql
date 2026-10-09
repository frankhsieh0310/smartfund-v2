CREATE TABLE IF NOT EXISTS "mortgage_rate_series" (
  "id" TEXT PRIMARY KEY, "series_code" TEXT NOT NULL UNIQUE, "official_name" TEXT NOT NULL,
  "display_name" TEXT NOT NULL, "jurisdiction" TEXT NOT NULL, "currency" TEXT,
  "mortgage_type" TEXT NOT NULL, "metric_kind" TEXT NOT NULL, "rate_type" TEXT NOT NULL,
  "fixing_period" TEXT, "maturity" TEXT, "observation_basis" TEXT NOT NULL,
  "statistic_type" TEXT NOT NULL, "frequency" TEXT NOT NULL, "unit" TEXT NOT NULL,
  "status" TEXT NOT NULL, "start_date" DATE NOT NULL, "end_date" DATE,
  "source" TEXT NOT NULL, "source_url" TEXT NOT NULL, "external_series_identifier" TEXT NOT NULL,
  "methodology_version" TEXT, "verification_state" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "mortgage_rate_series_jurisdiction_status_idx" ON "mortgage_rate_series"("jurisdiction","status");

ALTER TABLE "mortgage_rate_observations" ADD COLUMN IF NOT EXISTS "series_id" TEXT;
ALTER TABLE "mortgage_rate_observations" ADD COLUMN IF NOT EXISTS "value_semantics" TEXT;
ALTER TABLE "mortgage_rate_observations" ADD COLUMN IF NOT EXISTS "source_url" TEXT;
ALTER TABLE "mortgage_rate_observations" ADD COLUMN IF NOT EXISTS "verification_state" TEXT;
ALTER TABLE "mortgage_rate_observations" ADD COLUMN IF NOT EXISTS "raw_checksum" TEXT;
ALTER TABLE "mortgage_rate_observations" ADD COLUMN IF NOT EXISTS "source_version" TEXT;
ALTER TABLE "mortgage_rate_observations" ADD COLUMN IF NOT EXISTS "retrieved_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "mortgage_rate_observations_series_id_observation_date_key" ON "mortgage_rate_observations"("series_id","observation_date");

CREATE TABLE IF NOT EXISTS "mortgage_rate_observation_revisions" (
  "id" TEXT PRIMARY KEY, "series_id" TEXT NOT NULL, "observation_date" DATE NOT NULL,
  "prior_value" DECIMAL(18,8) NOT NULL, "replacement_value" DECIMAL(18,8) NOT NULL,
  "prior_checksum" TEXT NOT NULL, "replacement_checksum" TEXT NOT NULL,
  "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "source_version" TEXT NOT NULL,
  CONSTRAINT "mortgage_rate_revisions_series_fkey" FOREIGN KEY ("series_id") REFERENCES "mortgage_rate_series"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "mortgage_rate_revisions_identity_key" ON "mortgage_rate_observation_revisions"("series_id","observation_date","replacement_checksum");

CREATE TABLE IF NOT EXISTS "mortgage_rate_analytics" (
  "id" TEXT PRIMARY KEY, "series_id" TEXT NOT NULL, "as_of_date" DATE NOT NULL,
  "change_1w_bps" DECIMAL(18,6), "change_1m_bps" DECIMAL(18,6), "change_3m_bps" DECIMAL(18,6),
  "change_6m_bps" DECIMAL(18,6), "change_ytd_bps" DECIMAL(18,6), "change_1y_bps" DECIMAL(18,6),
  "change_3y_bps" DECIMAL(18,6), "change_5y_bps" DECIMAL(18,6), "change_10y_bps" DECIMAL(18,6),
  "rolling_52w_average" DECIMAL(18,8), "historical_percentile" DECIMAL(9,6),
  "weekly_change_volatility_bps" DECIMAL(18,6), "movement_from_peak_bps" DECIMAL(18,6),
  "movement_from_trough_bps" DECIMAL(18,6), "curve_30y_15y_spread_bps" DECIMAL(18,6),
  "calculation_version" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mortgage_rate_analytics_series_fkey" FOREIGN KEY ("series_id") REFERENCES "mortgage_rate_series"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "mortgage_rate_analytics_series_date_key" ON "mortgage_rate_analytics"("series_id","as_of_date");

CREATE TABLE IF NOT EXISTS "mortgage_rate_latest_snapshots" (
  "series_id" TEXT PRIMARY KEY, "observation_date" DATE NOT NULL, "value" DECIMAL(18,8) NOT NULL,
  "freshness_status" TEXT NOT NULL, "as_of_updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mortgage_rate_latest_series_fkey" FOREIGN KEY ("series_id") REFERENCES "mortgage_rate_series"("id")
);

CREATE TABLE IF NOT EXISTS "mortgage_rate_coverage" (
  "series_id" TEXT PRIMARY KEY, "identity_complete" BOOLEAN NOT NULL, "current_available" BOOLEAN NOT NULL,
  "history_rows" INTEGER NOT NULL, "earliest_date" DATE, "latest_date" DATE,
  "analytics_complete" BOOLEAN NOT NULL, "provenance_complete" BOOLEAN NOT NULL,
  "freshness_status" TEXT NOT NULL, "detail_readiness" TEXT NOT NULL, "calculated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mortgage_rate_coverage_series_fkey" FOREIGN KEY ("series_id") REFERENCES "mortgage_rate_series"("id")
);
