CREATE TABLE "fx_sources" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "official" BOOLEAN NOT NULL DEFAULT false, "legal_public" BOOLEAN NOT NULL DEFAULT true,
  "base_url" TEXT NOT NULL, "license_url" TEXT, "capabilities" JSONB NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true, "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "fx_currencies" (
  "code" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT 'FIAT',
  "iso_numeric" TEXT, "minor_units" INTEGER, "authority_id" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true, "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "fx_currencies_active_kind_idx" ON "fx_currencies"("active", "kind");
CREATE TABLE "fx_pairs" (
  "symbol" TEXT PRIMARY KEY, "base_currency" TEXT NOT NULL, "quote_currency" TEXT NOT NULL,
  "classification" TEXT NOT NULL, "provider_symbol" TEXT, "price_precision" INTEGER NOT NULL DEFAULT 6,
  "active" BOOLEAN NOT NULL DEFAULT true, "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fx_pairs_base_quote_key" UNIQUE ("base_currency", "quote_currency")
);
CREATE INDEX "fx_pairs_classification_active_idx" ON "fx_pairs"("classification", "active");
CREATE TABLE "fx_candles" (
  "pair_symbol" TEXT NOT NULL, "interval" TEXT NOT NULL, "open_time" TIMESTAMP(3) NOT NULL,
  "close_time" TIMESTAMP(3) NOT NULL, "open" DECIMAL(30,12) NOT NULL, "high" DECIMAL(30,12) NOT NULL,
  "low" DECIMAL(30,12) NOT NULL, "close" DECIMAL(30,12) NOT NULL, "bid" DECIMAL(30,12),
  "ask" DECIMAL(30,12), "mid" DECIMAL(30,12), "spread" DECIMAL(30,12), "volume" DECIMAL(30,8),
  "source" TEXT NOT NULL, "source_url" TEXT, "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("pair_symbol", "interval", "open_time", "source")
);
CREATE INDEX "fx_candles_interval_open_time_idx" ON "fx_candles"("interval", "open_time");
CREATE TABLE "fx_latest_quotes" (
  "pair_symbol" TEXT PRIMARY KEY, "bid" DECIMAL(30,12), "ask" DECIMAL(30,12),
  "mid" DECIMAL(30,12) NOT NULL, "spread" DECIMAL(30,12), "source" TEXT NOT NULL,
  "quoted_at" TIMESTAMP(3) NOT NULL, "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB
);
CREATE INDEX "fx_latest_quotes_quoted_at_idx" ON "fx_latest_quotes"("quoted_at");
CREATE TABLE "fx_reference_values" (
  "series_id" TEXT NOT NULL, "observed_at" TIMESTAMP(3) NOT NULL, "pair_symbol" TEXT NOT NULL DEFAULT '',
  "currency_code" TEXT NOT NULL DEFAULT '', "kind" TEXT NOT NULL, "value" DECIMAL(30,12) NOT NULL,
  "unit" TEXT, "source" TEXT NOT NULL, "source_url" TEXT, "published_at" TIMESTAMP(3),
  "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "metadata" JSONB,
  PRIMARY KEY ("series_id", "observed_at")
);
CREATE INDEX "fx_reference_values_kind_observed_at_idx" ON "fx_reference_values"("kind", "observed_at");
CREATE INDEX "fx_reference_values_pair_symbol_observed_at_idx" ON "fx_reference_values"("pair_symbol", "observed_at");
CREATE TABLE "fx_metrics" (
  "pair_symbol" TEXT NOT NULL, "interval" TEXT NOT NULL, "metric" TEXT NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL, "value" DECIMAL(30,12), "payload" JSONB,
  "source" TEXT NOT NULL DEFAULT 'SMARTFUND_DERIVED', "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("pair_symbol", "interval", "metric", "observed_at")
);
CREATE INDEX "fx_metrics_metric_observed_at_idx" ON "fx_metrics"("metric", "observed_at");
CREATE TABLE "fx_coverage" (
  "pair_symbol" TEXT NOT NULL, "capability" TEXT NOT NULL, "interval" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL, "provider" TEXT, "earliest_at" TIMESTAMP(3), "latest_at" TIMESTAMP(3),
  "freshness_seconds" INTEGER, "row_count" BIGINT NOT NULL DEFAULT 0, "quality_status" TEXT NOT NULL DEFAULT 'PENDING',
  "details" JSONB, "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("pair_symbol", "capability", "interval")
);
CREATE INDEX "fx_coverage_status_quality_status_idx" ON "fx_coverage"("status", "quality_status");
CREATE TABLE "fx_work_items" (
  "id" TEXT PRIMARY KEY, "dedupe_key" TEXT NOT NULL UNIQUE, "kind" TEXT NOT NULL, "pair_symbol" TEXT,
  "payload" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "priority" INTEGER NOT NULL DEFAULT 100,
  "attempts" INTEGER NOT NULL DEFAULT 0, "max_attempts" INTEGER NOT NULL DEFAULT 8,
  "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "last_error" TEXT, "checkpoint" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3)
);
CREATE INDEX "fx_work_items_status_next_run_at_priority_idx" ON "fx_work_items"("status", "next_run_at", "priority");
CREATE TABLE "fx_archive_manifests" (
  "id" TEXT PRIMARY KEY, "pair_symbol" TEXT NOT NULL, "interval" TEXT NOT NULL,
  "range_start" TIMESTAMP(3) NOT NULL, "range_end" TIMESTAMP(3) NOT NULL, "row_count" BIGINT NOT NULL,
  "checksum" TEXT NOT NULL, "storage_uri" TEXT NOT NULL, "source" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'AVAILABLE', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verified_at" TIMESTAMP(3),
  CONSTRAINT "fx_archive_manifests_scope_key" UNIQUE ("pair_symbol", "interval", "range_start", "range_end", "source")
);
CREATE INDEX "fx_archive_manifests_status_range_end_idx" ON "fx_archive_manifests"("status", "range_end");
