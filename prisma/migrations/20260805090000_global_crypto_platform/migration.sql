CREATE TABLE "crypto_networks" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "native_asset_id" TEXT, "chain_id" TEXT,
  "genesis_at" TIMESTAMPTZ, "official_url" TEXT NOT NULL, "explorer_url" TEXT,
  "source_url" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT TRUE, "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE "crypto_assets" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "symbol" TEXT NOT NULL, "network_id" TEXT,
  "contract_address" TEXT, "decimals" INTEGER, "genesis_at" TIMESTAMPTZ,
  "active" BOOLEAN NOT NULL DEFAULT TRUE, "wrapped_asset_id" TEXT,
  "stablecoin" BOOLEAN NOT NULL DEFAULT FALSE, "official_url" TEXT NOT NULL,
  "source_url" TEXT NOT NULL, "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "crypto_assets_network_contract_key" ON "crypto_assets"("network_id", "contract_address");
CREATE INDEX "crypto_assets_symbol_active_idx" ON "crypto_assets"("symbol", "active");
CREATE TABLE "crypto_exchanges" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "official_url" TEXT NOT NULL, "api_url" TEXT,
  "jurisdiction" TEXT, "active" BOOLEAN NOT NULL DEFAULT TRUE, "spot" BOOLEAN NOT NULL DEFAULT FALSE,
  "derivatives" BOOLEAN NOT NULL DEFAULT FALSE, "source_url" TEXT NOT NULL, "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE "crypto_markets" (
  "id" TEXT PRIMARY KEY, "exchange_id" TEXT NOT NULL, "base_asset_id" TEXT NOT NULL,
  "quote_asset_id" TEXT NOT NULL, "provider_symbol" TEXT NOT NULL, "market_type" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE, "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "crypto_markets_exchange_fk" FOREIGN KEY ("exchange_id") REFERENCES "crypto_exchanges"("id"),
  CONSTRAINT "crypto_markets_base_fk" FOREIGN KEY ("base_asset_id") REFERENCES "crypto_assets"("id"),
  CONSTRAINT "crypto_markets_quote_fk" FOREIGN KEY ("quote_asset_id") REFERENCES "crypto_assets"("id")
);
CREATE UNIQUE INDEX "crypto_markets_exchange_symbol_type_key" ON "crypto_markets"("exchange_id", "provider_symbol", "market_type");
CREATE INDEX "crypto_markets_base_type_idx" ON "crypto_markets"("base_asset_id", "market_type");
CREATE TABLE "crypto_candles" (
  "market_id" TEXT NOT NULL, "interval" TEXT NOT NULL, "open_time" TIMESTAMPTZ NOT NULL,
  "close_time" TIMESTAMPTZ NOT NULL, "open" DECIMAL(38,18) NOT NULL, "high" DECIMAL(38,18) NOT NULL,
  "low" DECIMAL(38,18) NOT NULL, "close" DECIMAL(38,18) NOT NULL, "volume" DECIMAL(38,18) NOT NULL,
  "quote_volume" DECIMAL(38,18), "trades" BIGINT, "source" TEXT NOT NULL, "source_payload" JSONB,
  "observed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY ("market_id", "interval", "open_time"),
  CONSTRAINT "crypto_candles_market_fk" FOREIGN KEY ("market_id") REFERENCES "crypto_markets"("id")
);
CREATE INDEX "crypto_candles_interval_time_idx" ON "crypto_candles"("interval", "open_time");
CREATE TABLE "crypto_metrics" (
  "asset_id" TEXT NOT NULL, "market_id" TEXT NOT NULL DEFAULT '', "metric" TEXT NOT NULL,
  "observed_at" TIMESTAMPTZ NOT NULL, "value" DECIMAL(38,18), "unit" TEXT, "payload" JSONB,
  "source" TEXT NOT NULL, "source_url" TEXT, "ingested_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("asset_id", "market_id", "metric", "observed_at")
);
CREATE INDEX "crypto_metrics_metric_time_idx" ON "crypto_metrics"("metric", "observed_at");
CREATE TABLE "crypto_coverage" (
  "asset_id" TEXT NOT NULL, "exchange_id" TEXT NOT NULL DEFAULT '', "capability" TEXT NOT NULL,
  "status" TEXT NOT NULL, "provider" TEXT, "earliest_at" TIMESTAMPTZ, "latest_at" TIMESTAMPTZ,
  "freshness_seconds" INTEGER, "row_count" BIGINT NOT NULL DEFAULT 0,
  "quality_status" TEXT NOT NULL DEFAULT 'PENDING', "details" JSONB,
  "checked_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY ("asset_id", "exchange_id", "capability")
);
CREATE INDEX "crypto_coverage_status_quality_idx" ON "crypto_coverage"("status", "quality_status");
CREATE TABLE "crypto_work_items" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "dedupe_key" TEXT NOT NULL UNIQUE, "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "priority" INTEGER NOT NULL DEFAULT 100,
  "attempts" INTEGER NOT NULL DEFAULT 0, "max_attempts" INTEGER NOT NULL DEFAULT 8,
  "next_run_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "last_error" TEXT, "checkpoint" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completed_at" TIMESTAMPTZ
);
CREATE INDEX "crypto_work_items_status_next_priority_idx" ON "crypto_work_items"("status", "next_run_at", "priority");
