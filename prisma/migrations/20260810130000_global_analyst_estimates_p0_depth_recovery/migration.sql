CREATE TABLE IF NOT EXISTS "fiscal_period_identity" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "stock_id" TEXT NOT NULL REFERENCES "stocks"("id") ON DELETE CASCADE,
  "fiscal_year" INTEGER NOT NULL, "fiscal_quarter" INTEGER, "period_type" TEXT NOT NULL,
  "period_start" DATE, "period_end" DATE NOT NULL, "issuer_fiscal_year_end_month" INTEGER,
  "calendar_normalized_label" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("stock_id","period_type","period_end")
);
CREATE INDEX IF NOT EXISTS "fiscal_period_identity_stock_period_idx" ON "fiscal_period_identity"("stock_id","period_end");

ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "fiscal_period_id" UUID REFERENCES "fiscal_period_identity"("id");
ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "period_type" TEXT;
ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "fiscal_period_end" DATE;
ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "value_mid" DECIMAL(30,8);
ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "gaap_status" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "guidance_type" TEXT NOT NULL DEFAULT 'POINT';
ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "source_record_id" TEXT;
ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "verification_status" TEXT NOT NULL DEFAULT 'VERIFIED';
ALTER TABLE "company_guidance" ADD COLUMN IF NOT EXISTS "retrieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "company_guidance" SET "value_mid"=COALESCE("point_value",("low_value"+"high_value")/2), "source_record_id"="filing_id",
  "gaap_status"=CASE WHEN "metric" LIKE 'NON_GAAP_%' THEN 'NON_GAAP' WHEN "metric" LIKE 'GAAP_%' THEN 'GAAP' ELSE 'UNKNOWN' END,
  "guidance_type"=CASE WHEN "low_value" IS NOT NULL AND "high_value" IS NOT NULL THEN 'RANGE' WHEN "point_value" IS NOT NULL THEN 'POINT' ELSE 'QUALITATIVE' END
WHERE "value_mid" IS NULL OR "source_record_id" IS NULL;

CREATE TABLE IF NOT EXISTS "company_guidance_revisions" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "stock_id" TEXT NOT NULL REFERENCES "stocks"("id") ON DELETE CASCADE,
 "fiscal_period_id" UUID REFERENCES "fiscal_period_identity"("id"), "metric" TEXT NOT NULL,
 "previous_guidance_id" UUID REFERENCES "company_guidance"("id"), "current_guidance_id" UUID NOT NULL REFERENCES "company_guidance"("id"),
 "revision_type" TEXT NOT NULL, "derived_status" TEXT NOT NULL DEFAULT 'DERIVED_FROM_VERIFIED_GUIDANCE', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("previous_guidance_id","current_guidance_id")
);

CREATE TABLE IF NOT EXISTS "analyst_estimate_providers" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "provider_id" TEXT NOT NULL UNIQUE, "provider_name" TEXT NOT NULL,
 "provider_type" TEXT NOT NULL, "license_status" TEXT NOT NULL, "redistribution_status" TEXT NOT NULL,
 "api_status" TEXT NOT NULL, "source_url" TEXT NOT NULL, "verification_status" TEXT NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "analyst_estimate_license_register" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "provider_id" UUID NOT NULL REFERENCES "analyst_estimate_providers"("id") ON DELETE CASCADE,
 "domains_available" JSONB NOT NULL, "access_status" TEXT NOT NULL, "redistribution_status" TEXT NOT NULL,
 "license_status" TEXT NOT NULL, "reviewed_at" TIMESTAMP(3), "notes" TEXT, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("provider_id")
);
CREATE TABLE IF NOT EXISTS "analysts" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "provider_id" UUID NOT NULL REFERENCES "analyst_estimate_providers"("id") ON DELETE CASCADE,
 "analyst_name" TEXT, "provider_analyst_id" TEXT, "status" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("provider_id","provider_analyst_id")
);
CREATE TABLE IF NOT EXISTS "analyst_estimate_observations" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "stock_id" TEXT NOT NULL REFERENCES "stocks"("id") ON DELETE CASCADE,
 "provider_id" UUID NOT NULL REFERENCES "analyst_estimate_providers"("id"), "analyst_id" UUID REFERENCES "analysts"("id"),
 "metric" TEXT NOT NULL, "fiscal_period_id" UUID NOT NULL REFERENCES "fiscal_period_identity"("id"), "as_of_date" DATE NOT NULL,
 "published_at" TIMESTAMP(3), "value" DECIMAL(30,8) NOT NULL, "currency" TEXT, "unit" TEXT NOT NULL,
 "gaap_status" TEXT NOT NULL, "estimate_type" TEXT NOT NULL, "source_record_id" TEXT NOT NULL,
 "verification_status" TEXT NOT NULL, "retrieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("provider_id","source_record_id")
);
CREATE INDEX IF NOT EXISTS "analyst_estimate_observation_pit_idx" ON "analyst_estimate_observations"("stock_id","metric","fiscal_period_id","as_of_date");

CREATE TABLE IF NOT EXISTS "analyst_consensus_snapshots" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "stock_id" TEXT NOT NULL REFERENCES "stocks"("id") ON DELETE CASCADE,
 "provider_id" UUID NOT NULL REFERENCES "analyst_estimate_providers"("id"), "metric" TEXT NOT NULL,
 "fiscal_period_id" UUID NOT NULL REFERENCES "fiscal_period_identity"("id"), "as_of_date" DATE NOT NULL,
 "mean" DECIMAL(30,8), "median" DECIMAL(30,8), "high" DECIMAL(30,8), "low" DECIMAL(30,8),
 "analyst_count" INTEGER, "estimate_count" INTEGER, "currency" TEXT, "unit" TEXT NOT NULL, "gaap_status" TEXT NOT NULL,
 "source" TEXT NOT NULL, "source_record_id" TEXT, "verification_status" TEXT NOT NULL, "retrieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("stock_id","provider_id","metric","fiscal_period_id","as_of_date")
);
CREATE TABLE IF NOT EXISTS "analyst_estimate_revisions" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "stock_id" TEXT NOT NULL REFERENCES "stocks"("id") ON DELETE CASCADE,
 "metric" TEXT NOT NULL, "fiscal_period_id" UUID NOT NULL REFERENCES "fiscal_period_identity"("id"),
 "provider_id" UUID NOT NULL REFERENCES "analyst_estimate_providers"("id"), "analyst_id" UUID REFERENCES "analysts"("id"),
 "previous_estimate" DECIMAL(30,8), "new_estimate" DECIMAL(30,8), "revision_direction" TEXT NOT NULL,
 "previous_as_of_date" DATE, "new_as_of_date" DATE NOT NULL, "source" TEXT NOT NULL, "verification_status" TEXT NOT NULL,
 "derivation_method" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "analyst_target_prices" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "stock_id" TEXT NOT NULL REFERENCES "stocks"("id") ON DELETE CASCADE,
 "provider_id" UUID NOT NULL REFERENCES "analyst_estimate_providers"("id"), "analyst_id" UUID REFERENCES "analysts"("id"),
 "as_of_date" DATE NOT NULL, "target_price" DECIMAL(30,8) NOT NULL, "currency" TEXT NOT NULL,
 "previous_target_price" DECIMAL(30,8), "action" TEXT NOT NULL, "source" TEXT NOT NULL, "source_record_id" TEXT,
 "verification_status" TEXT NOT NULL, "retrieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "consensus_target_price_snapshots" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "stock_id" TEXT NOT NULL REFERENCES "stocks"("id") ON DELETE CASCADE,
 "provider_id" UUID NOT NULL REFERENCES "analyst_estimate_providers"("id"), "as_of_date" DATE NOT NULL,
 "mean" DECIMAL(30,8), "median" DECIMAL(30,8), "high" DECIMAL(30,8), "low" DECIMAL(30,8), "analyst_count" INTEGER,
 "currency" TEXT NOT NULL, "source" TEXT NOT NULL, "source_record_id" TEXT, "verification_status" TEXT NOT NULL,
 UNIQUE("stock_id","provider_id","as_of_date")
);
CREATE TABLE IF NOT EXISTS "provider_rating_normalization" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "provider_id" UUID NOT NULL REFERENCES "analyst_estimate_providers"("id") ON DELETE CASCADE,
 "rating_raw" TEXT NOT NULL, "rating_normalized" TEXT NOT NULL, "verification_status" TEXT NOT NULL, UNIQUE("provider_id","rating_raw")
);
CREATE TABLE IF NOT EXISTS "analyst_ratings" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "stock_id" TEXT NOT NULL REFERENCES "stocks"("id") ON DELETE CASCADE,
 "provider_id" UUID NOT NULL REFERENCES "analyst_estimate_providers"("id"), "analyst_id" UUID REFERENCES "analysts"("id"),
 "rating_raw" TEXT NOT NULL, "rating_normalized" TEXT NOT NULL, "as_of_date" DATE NOT NULL, "previous_rating_raw" TEXT,
 "action" TEXT NOT NULL, "source" TEXT NOT NULL, "source_record_id" TEXT, "verification_status" TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS "analyst_rating_distributions" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "stock_id" TEXT NOT NULL REFERENCES "stocks"("id") ON DELETE CASCADE,
 "provider_id" UUID NOT NULL REFERENCES "analyst_estimate_providers"("id"), "as_of_date" DATE NOT NULL,
 "buy_count" INTEGER NOT NULL, "hold_count" INTEGER NOT NULL, "sell_count" INTEGER NOT NULL,
 "coverage_count" INTEGER NOT NULL, "provider_universe" TEXT NOT NULL, "source" TEXT NOT NULL, "verification_status" TEXT NOT NULL,
 UNIQUE("stock_id","provider_id","as_of_date")
);
CREATE TABLE IF NOT EXISTS "analyst_estimate_coverage_matrix" (
 "stock_id" TEXT PRIMARY KEY REFERENCES "stocks"("id") ON DELETE CASCADE, "guidance_status" TEXT NOT NULL,
 "guidance_history_count" INTEGER NOT NULL DEFAULT 0, "consensus_source_status" TEXT NOT NULL,
 "revenue_estimate_status" TEXT NOT NULL, "eps_estimate_status" TEXT NOT NULL, "ebitda_estimate_status" TEXT NOT NULL,
 "net_income_estimate_status" TEXT NOT NULL, "target_price_status" TEXT NOT NULL, "rating_status" TEXT NOT NULL,
 "buy_hold_sell_status" TEXT NOT NULL, "revision_status" TEXT NOT NULL, "fiscal_period_normalization_status" TEXT NOT NULL,
 "actual_link_status" TEXT NOT NULL, "surprise_status" TEXT NOT NULL, "provider_count" INTEGER NOT NULL DEFAULT 0,
 "analyst_count" INTEGER, "provenance_status" TEXT NOT NULL, "freshness_status" TEXT NOT NULL,
 "license_status" TEXT NOT NULL, "coverage_status" TEXT NOT NULL, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
