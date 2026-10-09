ALTER TABLE "crypto_assets"
  ADD COLUMN IF NOT EXISTS "provider_external_id" TEXT,
  ADD COLUMN IF NOT EXISTS "asset_type" TEXT,
  ADD COLUMN IF NOT EXISTS "taxonomy" TEXT,
  ADD COLUMN IF NOT EXISTS "primary_quote_asset_id" TEXT,
  ADD COLUMN IF NOT EXISTS "primary_market_id" TEXT,
  ADD COLUMN IF NOT EXISTS "token_standard" TEXT,
  ADD COLUMN IF NOT EXISTS "identity_source" TEXT;

ALTER TABLE "crypto_candles"
  ADD COLUMN IF NOT EXISTS "source_record_id" TEXT,
  ADD COLUMN IF NOT EXISTS "freshness_status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS "crypto_market_snapshots" (
  "market_id" TEXT NOT NULL, "observed_at" TIMESTAMPTZ NOT NULL, "price" DECIMAL(38,18) NOT NULL,
  "quote_currency" TEXT NOT NULL, "volume_24h" DECIMAL(38,18), "change_24h" DECIMAL(38,18),
  "change_percent_24h" DECIMAL(20,10), "bid" DECIMAL(38,18), "ask" DECIMAL(38,18), "spread" DECIMAL(38,18),
  "source" TEXT NOT NULL, "source_record_id" TEXT, "freshness_status" TEXT NOT NULL, "source_payload" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("market_id","observed_at")
);
CREATE INDEX IF NOT EXISTS "crypto_market_snapshots_observed_idx" ON "crypto_market_snapshots"("observed_at");

CREATE TABLE IF NOT EXISTS "crypto_market_cap_supply" (
  "asset_id" TEXT NOT NULL, "observed_at" TIMESTAMPTZ NOT NULL, "market_cap" DECIMAL(38,8),
  "fully_diluted_valuation" DECIMAL(38,8), "circulating_supply" DECIMAL(38,8), "total_supply" DECIMAL(38,8),
  "max_supply" DECIMAL(38,8), "market_cap_rank" INTEGER, "source" TEXT NOT NULL, "source_record_id" TEXT,
  "freshness_status" TEXT NOT NULL, "source_payload" JSONB, "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY ("asset_id","observed_at")
);
CREATE INDEX IF NOT EXISTS "crypto_market_cap_supply_observed_idx" ON "crypto_market_cap_supply"("observed_at");

CREATE TABLE IF NOT EXISTS "crypto_analytics" (
  "asset_id" TEXT NOT NULL, "metric" TEXT NOT NULL, "period" TEXT NOT NULL, "as_of_date" DATE NOT NULL,
  "value" DECIMAL(38,18), "calculation_method" TEXT NOT NULL, "source" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("asset_id","metric","period","as_of_date")
);
CREATE INDEX IF NOT EXISTS "crypto_analytics_metric_date_idx" ON "crypto_analytics"("metric","as_of_date");
