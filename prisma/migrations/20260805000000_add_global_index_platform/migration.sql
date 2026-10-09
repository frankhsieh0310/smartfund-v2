-- Package only. Do not apply until the GLOBAL_INDEX production migration is approved.
CREATE TABLE "global_index_registry" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "symbol" TEXT NOT NULL,
  "country" TEXT, "region" TEXT NOT NULL, "provider" TEXT NOT NULL, "exchange" TEXT,
  "currency" TEXT, "timezone" TEXT NOT NULL, "return_type" TEXT NOT NULL,
  "methodology_url" TEXT, "source_lineage" JSONB NOT NULL, "launch_date" DATE,
  "base_date" DATE, "base_value" DECIMAL(24,6), "active" BOOLEAN NOT NULL DEFAULT true,
  "licensing_status" TEXT NOT NULL, "official_source" BOOLEAN NOT NULL DEFAULT false,
  "update_frequency" TEXT NOT NULL, "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "global_index_registry_symbol_return_type_currency_key" ON "global_index_registry"("symbol","return_type","currency");
CREATE INDEX "global_index_registry_region_active_idx" ON "global_index_registry"("region","active");
CREATE TABLE "global_index_candles" (
  "index_id" TEXT NOT NULL, "interval" TEXT NOT NULL, "timestamp" TIMESTAMP(3) NOT NULL,
  "open" DECIMAL(30,10) NOT NULL, "high" DECIMAL(30,10) NOT NULL, "low" DECIMAL(30,10) NOT NULL,
  "close" DECIMAL(30,10) NOT NULL, "volume" DECIMAL(30,4), "timezone" TEXT NOT NULL,
  "session" TEXT NOT NULL, "source" TEXT NOT NULL, "completeness" TEXT NOT NULL,
  "quality_status" TEXT NOT NULL, "source_payload" JSONB,
  "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_index_candles_pkey" PRIMARY KEY ("index_id","interval","timestamp","source")
);
CREATE INDEX "global_index_candles_interval_timestamp_idx" ON "global_index_candles"("interval","timestamp");
CREATE TABLE "global_index_coverage" (
  "index_id" TEXT NOT NULL, "capability" TEXT NOT NULL, "interval" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL, "provider" TEXT, "licensing_status" TEXT NOT NULL,
  "earliest_at" TIMESTAMP(3), "latest_at" TIMESTAMP(3), "row_count" BIGINT NOT NULL DEFAULT 0,
  "quality_status" TEXT NOT NULL DEFAULT 'PENDING', "details" JSONB,
  "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_index_coverage_pkey" PRIMARY KEY ("index_id","capability","interval")
);
CREATE INDEX "global_index_coverage_status_quality_status_idx" ON "global_index_coverage"("status","quality_status");
CREATE TABLE "global_index_work_items" (
  "id" TEXT PRIMARY KEY, "dedupe_key" TEXT NOT NULL UNIQUE, "index_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "payload" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0, "max_attempts" INTEGER NOT NULL DEFAULT 8,
  "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "last_error" TEXT,
  "checkpoint" JSONB, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" TIMESTAMP(3)
);
CREATE INDEX "global_index_work_items_status_next_run_at_idx" ON "global_index_work_items"("status","next_run_at");
