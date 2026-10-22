CREATE TABLE IF NOT EXISTS "institutional_holdings" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "institution_id" TEXT NOT NULL,
  "institution_name" TEXT NOT NULL,
  "security_id" TEXT NOT NULL REFERENCES "securities"("id"),
  "report_date" DATE NOT NULL,
  "shares" DECIMAL(30,6) NOT NULL,
  "value" DECIMAL(30,6),
  "source" TEXT NOT NULL,
  "filing_id" TEXT NOT NULL,
  "source_key" TEXT NOT NULL UNIQUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "institutional_holdings_institution_date_idx" ON "institutional_holdings"("institution_id", "report_date");
CREATE INDEX IF NOT EXISTS "institutional_holdings_security_date_idx" ON "institutional_holdings"("security_id", "report_date");

CREATE TABLE IF NOT EXISTS "insider_ownership_transactions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "security_id" TEXT NOT NULL REFERENCES "securities"("id"),
  "insider" TEXT NOT NULL,
  "role" TEXT,
  "transaction_date" DATE NOT NULL,
  "transaction_type" TEXT NOT NULL,
  "shares" DECIMAL(30,6) NOT NULL,
  "price" DECIMAL(30,6),
  "ownership_after" DECIMAL(30,6),
  "source" TEXT NOT NULL,
  "filing_id" TEXT NOT NULL,
  "source_key" TEXT NOT NULL UNIQUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "insider_ownership_security_date_idx" ON "insider_ownership_transactions"("security_id", "transaction_date");
CREATE INDEX IF NOT EXISTS "insider_ownership_insider_date_idx" ON "insider_ownership_transactions"("insider", "transaction_date");

CREATE TABLE IF NOT EXISTS "electricity_observations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "market" TEXT NOT NULL,
  "region" TEXT,
  "node" TEXT,
  "observed_at" TIMESTAMPTZ NOT NULL,
  "timezone" TEXT NOT NULL,
  "metric_type" TEXT NOT NULL,
  "value" DECIMAL(30,8) NOT NULL,
  "unit" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "source_key" TEXT NOT NULL UNIQUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "electricity_observations_market_time_idx" ON "electricity_observations"("market", "observed_at");
CREATE INDEX IF NOT EXISTS "electricity_observations_metric_time_idx" ON "electricity_observations"("metric_type", "observed_at");

CREATE TABLE IF NOT EXISTS "crypto_networks" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "native_asset_id" TEXT, "chain_id" TEXT,
  "genesis_at" TIMESTAMPTZ, "official_url" TEXT NOT NULL, "explorer_url" TEXT, "source_url" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE, "metadata" JSONB, "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS "crypto_assets" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "symbol" TEXT NOT NULL, "network_id" TEXT, "contract_address" TEXT,
  "decimals" INTEGER, "genesis_at" TIMESTAMPTZ, "active" BOOLEAN NOT NULL DEFAULT TRUE, "wrapped_asset_id" TEXT,
  "stablecoin" BOOLEAN NOT NULL DEFAULT FALSE, "official_url" TEXT NOT NULL, "source_url" TEXT NOT NULL, "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "crypto_assets_network_contract_key" ON "crypto_assets"("network_id", "contract_address");
CREATE INDEX IF NOT EXISTS "crypto_assets_symbol_active_idx" ON "crypto_assets"("symbol", "active");
CREATE TABLE IF NOT EXISTS "crypto_exchanges" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "official_url" TEXT NOT NULL, "api_url" TEXT, "jurisdiction" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT TRUE, "spot" BOOLEAN NOT NULL DEFAULT FALSE, "derivatives" BOOLEAN NOT NULL DEFAULT FALSE,
  "source_url" TEXT NOT NULL, "metadata" JSONB, "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS "crypto_markets" (
  "id" TEXT PRIMARY KEY, "exchange_id" TEXT NOT NULL REFERENCES "crypto_exchanges"("id"),
  "base_asset_id" TEXT NOT NULL REFERENCES "crypto_assets"("id"), "quote_asset_id" TEXT NOT NULL REFERENCES "crypto_assets"("id"),
  "provider_symbol" TEXT NOT NULL, "market_type" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT TRUE, "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "crypto_markets_exchange_symbol_type_key" ON "crypto_markets"("exchange_id", "provider_symbol", "market_type");
CREATE INDEX IF NOT EXISTS "crypto_markets_base_type_idx" ON "crypto_markets"("base_asset_id", "market_type");
CREATE TABLE IF NOT EXISTS "crypto_candles" (
  "market_id" TEXT NOT NULL REFERENCES "crypto_markets"("id"), "interval" TEXT NOT NULL, "open_time" TIMESTAMPTZ NOT NULL,
  "close_time" TIMESTAMPTZ NOT NULL, "open" DECIMAL(38,18) NOT NULL, "high" DECIMAL(38,18) NOT NULL, "low" DECIMAL(38,18) NOT NULL,
  "close" DECIMAL(38,18) NOT NULL, "volume" DECIMAL(38,18) NOT NULL, "quote_volume" DECIMAL(38,18), "trades" BIGINT,
  "source" TEXT NOT NULL, "source_payload" JSONB, "observed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY ("market_id", "interval", "open_time")
);
CREATE INDEX IF NOT EXISTS "crypto_candles_interval_time_idx" ON "crypto_candles"("interval", "open_time");
CREATE TABLE IF NOT EXISTS "crypto_metrics" (
  "asset_id" TEXT NOT NULL, "market_id" TEXT NOT NULL DEFAULT '', "metric" TEXT NOT NULL, "observed_at" TIMESTAMPTZ NOT NULL,
  "value" DECIMAL(38,18), "unit" TEXT, "payload" JSONB, "source" TEXT NOT NULL, "source_url" TEXT,
  "ingested_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY ("asset_id", "market_id", "metric", "observed_at")
);
CREATE INDEX IF NOT EXISTS "crypto_metrics_metric_time_idx" ON "crypto_metrics"("metric", "observed_at");
CREATE TABLE IF NOT EXISTS "crypto_coverage" (
  "asset_id" TEXT NOT NULL, "exchange_id" TEXT NOT NULL DEFAULT '', "capability" TEXT NOT NULL, "status" TEXT NOT NULL,
  "provider" TEXT, "earliest_at" TIMESTAMPTZ, "latest_at" TIMESTAMPTZ, "freshness_seconds" INTEGER,
  "row_count" BIGINT NOT NULL DEFAULT 0, "quality_status" TEXT NOT NULL DEFAULT 'PENDING', "details" JSONB,
  "checked_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY ("asset_id", "exchange_id", "capability")
);
CREATE INDEX IF NOT EXISTS "crypto_coverage_status_quality_idx" ON "crypto_coverage"("status", "quality_status");
CREATE TABLE IF NOT EXISTS "crypto_work_items" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "dedupe_key" TEXT NOT NULL UNIQUE, "kind" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "priority" INTEGER NOT NULL DEFAULT 100, "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 8, "next_run_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "last_error" TEXT, "checkpoint" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "completed_at" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "crypto_work_items_status_next_priority_idx" ON "crypto_work_items"("status", "next_run_at", "priority");
