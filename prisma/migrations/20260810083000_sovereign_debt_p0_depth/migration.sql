CREATE TABLE IF NOT EXISTS "sovereign_identities" (
  "id" TEXT PRIMARY KEY, "iso2" TEXT NOT NULL UNIQUE, "iso3" TEXT NOT NULL UNIQUE,
  "official_name" TEXT NOT NULL, "short_name" TEXT NOT NULL, "region" TEXT NOT NULL,
  "currency" TEXT NOT NULL, "jurisdiction_type" TEXT NOT NULL, "status" TEXT NOT NULL,
  "source_authority" TEXT NOT NULL, "start_date" DATE, "end_date" DATE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "sovereign_debt_series" (
  "id" TEXT PRIMARY KEY, "sovereign_id" TEXT NOT NULL, "metric_code" TEXT NOT NULL,
  "metric_name" TEXT NOT NULL, "debt_definition" TEXT NOT NULL, "government_level" TEXT NOT NULL,
  "gross_or_net" TEXT NOT NULL, "consolidation_basis" TEXT NOT NULL, "residency_basis" TEXT NOT NULL,
  "instrument_coverage" TEXT NOT NULL, "valuation_basis" TEXT NOT NULL, "currency_basis" TEXT NOT NULL,
  "frequency" TEXT NOT NULL, "unit" TEXT NOT NULL, "source_authority" TEXT NOT NULL,
  "source_id" TEXT NOT NULL, "source_url" TEXT NOT NULL, "comparability_status" TEXT NOT NULL,
  "comparison_reason" TEXT NOT NULL, "status" TEXT NOT NULL, "start_date" DATE, "end_date" DATE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sovereign_debt_series_sovereign_id_fkey" FOREIGN KEY ("sovereign_id") REFERENCES "sovereign_identities"("id"),
  UNIQUE ("sovereign_id", "metric_code", "source_id")
);
CREATE INDEX IF NOT EXISTS "sovereign_debt_series_sovereign_metric_idx" ON "sovereign_debt_series"("sovereign_id", "metric_code");

INSERT INTO "sovereign_identities" ("id","iso2","iso3","official_name","short_name","region","currency","jurisdiction_type","status","source_authority")
VALUES ('sovereign-us','US','USA','United States of America','United States','NORTHERN_AMERICA','USD','SOVEREIGN_STATE','ACTIVE','U.S. Government')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "sovereign_debt_series" ("id","sovereign_id","metric_code","metric_name","debt_definition","government_level","gross_or_net","consolidation_basis","residency_basis","instrument_coverage","valuation_basis","currency_basis","frequency","unit","source_authority","source_id","source_url","comparability_status","comparison_reason","status") VALUES
('us-total-public-debt','sovereign-us','TOTAL_PUBLIC_DEBT','Total Public Debt Outstanding','Treasury total public debt outstanding','FEDERAL_GOVERNMENT','GROSS','INTRAGOVERNMENTAL_COMPONENT_REPORTED_SEPARATELY','HOLDER_RESIDENCY_NOT_RESTRICTED','TREASURY_SECURITIES_AND_STATUTORY_FEDERAL_DEBT_COMPONENTS','FACE_VALUE','NOMINAL_USD','MONTHLY','USD','U.S. Department of the Treasury','US_TREASURY_FISCAL_DATA_DEBT_TO_PENNY','https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny','PARTIALLY_COMPARABLE','Comparable only to federal gross debt series with matching coverage and valuation','ACTIVE'),
('us-debt-held-public','sovereign-us','DEBT_HELD_BY_PUBLIC','Debt Held by the Public','Treasury federal debt held by the public','FEDERAL_GOVERNMENT','GROSS','EXCLUDES_INTRAGOVERNMENTAL_HOLDINGS','HOLDER_RESIDENCY_NOT_RESTRICTED','TREASURY_SECURITIES_HELD_OUTSIDE_FEDERAL_ACCOUNTS','FACE_VALUE','NOMINAL_USD','MONTHLY','USD','U.S. Department of the Treasury','US_TREASURY_FISCAL_DATA_DEBT_TO_PENNY','https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny','NOT_COMPARABLE','Holder boundary differs from general-government gross debt','ACTIVE'),
('us-intragov','sovereign-us','INTRAGOVERNMENTAL_HOLDINGS','Intragovernmental Holdings','Treasury federal intragovernmental holdings','FEDERAL_GOVERNMENT','GROSS','INTRAGOVERNMENTAL_COMPONENT','NOT_APPLICABLE','TREASURY_SECURITIES_HELD_BY_FEDERAL_ACCOUNTS','FACE_VALUE','NOMINAL_USD','MONTHLY','USD','U.S. Department of the Treasury','US_TREASURY_FISCAL_DATA_DEBT_TO_PENNY','https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny','NOT_COMPARABLE','US-specific intragovernmental component','ACTIVE')
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "sovereign_id" TEXT;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "series_id" TEXT;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "publication_date" DATE;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "published_at" TIMESTAMP(3);
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "retrieved_at" TIMESTAMP(3);
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "government_level" TEXT;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "source_authority" TEXT;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "source_url" TEXT;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "verification_status" TEXT;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "quality_status" TEXT;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "freshness_status" TEXT;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "parser_version" TEXT;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "checksum" TEXT;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "vintage_id" TEXT;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "revision_sequence" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "is_current" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "sovereign_debt_observations" ADD COLUMN IF NOT EXISTS "supersedes_id" TEXT;
ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "period_end" SET NOT NULL;
ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "value" TYPE DECIMAL(30,8);

UPDATE "sovereign_debt_observations" SET
  "sovereign_id"='sovereign-us',
  "series_id"=CASE "metric_code" WHEN 'TOTAL_PUBLIC_DEBT_OUTSTANDING' THEN 'us-total-public-debt' WHEN 'TOTAL_PUBLIC_DEBT' THEN 'us-total-public-debt' WHEN 'DEBT_HELD_BY_PUBLIC' THEN 'us-debt-held-public' ELSE 'us-intragov' END,
  "metric_code"=CASE WHEN "metric_code"='TOTAL_PUBLIC_DEBT_OUTSTANDING' THEN 'TOTAL_PUBLIC_DEBT' ELSE "metric_code" END,
  "publication_date"="observation_date", "retrieved_at"="updated_at", "government_level"='FEDERAL_GOVERNMENT',
  "source_authority"='U.S. Department of the Treasury',
  "source_url"='https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny',
  "verification_status"='VERIFIED_OFFICIAL', "quality_status"='RECONCILIATION_PENDING', "freshness_status"='CURRENT',
  "parser_version"='sovereign-debt-p0-v1', "vintage_id"=concat('treasury-',"observation_date"::text)
WHERE "sovereign_id" IS NULL;

ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "sovereign_id" SET NOT NULL;
ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "series_id" SET NOT NULL;
ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "retrieved_at" SET NOT NULL;
ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "government_level" SET NOT NULL;
ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "source_authority" SET NOT NULL;
ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "source_url" SET NOT NULL;
ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "verification_status" SET NOT NULL;
ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "quality_status" SET NOT NULL;
ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "freshness_status" SET NOT NULL;
ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "parser_version" SET NOT NULL;
ALTER TABLE "sovereign_debt_observations" ALTER COLUMN "vintage_id" SET NOT NULL;
DROP INDEX IF EXISTS "sovereign_debt_observations_country_metric_code_observ_key";
CREATE UNIQUE INDEX IF NOT EXISTS "sovereign_debt_observations_series_date_vintage_key" ON "sovereign_debt_observations"("series_id","observation_date","vintage_id");
CREATE INDEX IF NOT EXISTS "sovereign_debt_observations_sovereign_date_idx" ON "sovereign_debt_observations"("sovereign_id","observation_date");
CREATE INDEX IF NOT EXISTS "sovereign_debt_observations_series_date_idx" ON "sovereign_debt_observations"("series_id","observation_date");

CREATE TABLE IF NOT EXISTS "sovereign_debt_analytics" (
  "id" TEXT PRIMARY KEY, "series_id" TEXT NOT NULL, "observation_date" DATE NOT NULL,
  "analytic_code" TEXT NOT NULL, "value" DECIMAL(30,10) NOT NULL, "unit" TEXT NOT NULL,
  "input_start_date" DATE NOT NULL, "input_end_date" DATE NOT NULL, "formula_version" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("series_id","observation_date","analytic_code","formula_version")
);
CREATE INDEX IF NOT EXISTS "sovereign_debt_analytics_series_code_date_idx" ON "sovereign_debt_analytics"("series_id","analytic_code","observation_date");

CREATE TABLE IF NOT EXISTS "sovereign_debt_events" (
  "id" TEXT PRIMARY KEY, "sovereign_id" TEXT NOT NULL, "series_id" TEXT, "event_type" TEXT NOT NULL,
  "effective_date" DATE NOT NULL, "published_at" TIMESTAMP(3), "source_id" TEXT NOT NULL,
  "source_url" TEXT NOT NULL, "vintage_id" TEXT, "details" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("source_id","event_type","effective_date","vintage_id")
);
CREATE INDEX IF NOT EXISTS "sovereign_debt_events_sovereign_date_idx" ON "sovereign_debt_events"("sovereign_id","effective_date");

CREATE TABLE IF NOT EXISTS "sovereign_debt_coverage" (
  "series_id" TEXT PRIMARY KEY, "identity_ready" BOOLEAN NOT NULL, "definition_ready" BOOLEAN NOT NULL,
  "latest_ready" BOOLEAN NOT NULL, "history_ready" BOOLEAN NOT NULL, "history_count" INTEGER NOT NULL,
  "history_start" DATE, "history_end" DATE, "publication_ready" BOOLEAN NOT NULL,
  "revision_ready" BOOLEAN NOT NULL, "provenance_ready" BOOLEAN NOT NULL, "freshness_ready" BOOLEAN NOT NULL,
  "analytics_ready" BOOLEAN NOT NULL, "comparability_status" TEXT NOT NULL, "missing_reasons" JSONB NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
