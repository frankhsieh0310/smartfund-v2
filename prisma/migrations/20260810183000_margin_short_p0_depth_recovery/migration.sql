ALTER TABLE "securities_lending_observations" ALTER COLUMN "stock_id" DROP NOT NULL;
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "grain_type" TEXT NOT NULL DEFAULT 'SECURITY_LEVEL';
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "publication_date" DATE;
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "source_url" TEXT;
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "source_record_id" TEXT;
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "retrieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "verification_status" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "freshness_status" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "publication_frequency" TEXT;
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "checksum" TEXT;
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "formula_code" TEXT;
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "formula_version" TEXT;
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "numerator_metric" TEXT;
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "denominator_metric" TEXT;
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "date_alignment_policy" TEXT;
ALTER TABLE "securities_lending_observations" ADD COLUMN IF NOT EXISTS "revision_number" INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS "margin_short_market_grain_key" ON "securities_lending_observations" ("market", "observation_date", "metric_type") WHERE "grain_type" = 'MARKET_LEVEL';
CREATE INDEX IF NOT EXISTS "margin_short_grain_metric_date_idx" ON "securities_lending_observations" ("grain_type", "metric_type", "observation_date");
ALTER TABLE "securities_lending_observations" DROP CONSTRAINT IF EXISTS "margin_short_grain_contract";
ALTER TABLE "securities_lending_observations" ADD CONSTRAINT "margin_short_grain_contract" CHECK (("grain_type" = 'SECURITY_LEVEL' AND "stock_id" IS NOT NULL) OR ("grain_type" = 'MARKET_LEVEL' AND "stock_id" IS NULL));

CREATE TABLE IF NOT EXISTS "margin_short_markets" (
  "market_id" TEXT PRIMARY KEY, "country" TEXT NOT NULL, "jurisdiction" TEXT NOT NULL,
  "currency" TEXT NOT NULL, "timezone" TEXT NOT NULL, "publication_frequency" TEXT NOT NULL,
  "official_source" TEXT NOT NULL, "official_source_url" TEXT NOT NULL, "source_status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "margin_short_metric_taxonomy" (
  "metric_code" TEXT PRIMARY KEY, "description" TEXT NOT NULL, "allowed_units" TEXT[] NOT NULL,
  "source_or_derived" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "margin_short_analytics" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "grain_type" TEXT NOT NULL, "market_id" TEXT NOT NULL,
  "security_id" TEXT, "base_metric" TEXT NOT NULL, "analytic_code" TEXT NOT NULL, "as_of_date" DATE NOT NULL,
  "value" NUMERIC(24,8) NOT NULL, "unit" TEXT NOT NULL, "formula_code" TEXT NOT NULL,
  "formula_version" TEXT NOT NULL, "date_alignment_policy" TEXT NOT NULL, "verification_status" TEXT NOT NULL,
  "total_eligible" INTEGER, "ranked_count" INTEGER, "excluded_count" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("grain_type","market_id","security_id","base_metric","analytic_code","as_of_date")
);

CREATE TABLE IF NOT EXISTS "margin_short_market_capabilities" (
  "market_id" TEXT NOT NULL, "metric_code" TEXT NOT NULL, "grain_type" TEXT NOT NULL,
  "source_status" TEXT NOT NULL, "frequency" TEXT, "official_source_url" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY("market_id","metric_code","grain_type")
);
