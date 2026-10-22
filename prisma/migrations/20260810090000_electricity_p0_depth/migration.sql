ALTER TABLE "electricity_observations"
  ADD COLUMN IF NOT EXISTS "canonical_market_id" TEXT,
  ADD COLUMN IF NOT EXISTS "canonical_location_id" TEXT,
  ADD COLUMN IF NOT EXISTS "product_type" TEXT,
  ADD COLUMN IF NOT EXISTS "price_type" TEXT,
  ADD COLUMN IF NOT EXISTS "delivery_end" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "delivery_local_date" TEXT,
  ADD COLUMN IF NOT EXISTS "delivery_local_start" TEXT,
  ADD COLUMN IF NOT EXISTS "interval_minutes" INTEGER,
  ADD COLUMN IF NOT EXISTS "currency" TEXT,
  ADD COLUMN IF NOT EXISTS "source_url" TEXT,
  ADD COLUMN IF NOT EXISTS "retrieved_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "verification_status" TEXT,
  ADD COLUMN IF NOT EXISTS "freshness_status" TEXT,
  ADD COLUMN IF NOT EXISTS "settlement_status" TEXT;

CREATE TABLE IF NOT EXISTS "electricity_markets" (
  "canonical_market_id" TEXT PRIMARY KEY,
  "official_name" TEXT NOT NULL,
  "short_name" TEXT NOT NULL,
  "operator" TEXT NOT NULL,
  "operator_type" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "market_type" TEXT NOT NULL,
  "official_url" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "electricity_locations" (
  "canonical_location_id" TEXT PRIMARY KEY,
  "canonical_market_id" TEXT NOT NULL,
  "official_code" TEXT NOT NULL,
  "official_name" TEXT NOT NULL,
  "location_type" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "region" TEXT,
  "status" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "electricity_locations_market_code_key" UNIQUE ("canonical_market_id", "official_code")
);

CREATE INDEX IF NOT EXISTS "electricity_observations_canonical_series_idx"
  ON "electricity_observations"("canonical_market_id", "canonical_location_id", "product_type", "price_type", "observed_at");
