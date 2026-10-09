CREATE TABLE "currency_index_profiles" (
  "id" UUID NOT NULL, "symbol" TEXT NOT NULL, "official_name" TEXT NOT NULL, "display_name" TEXT NOT NULL,
  "provider" TEXT NOT NULL, "provider_external_id" TEXT, "currency" TEXT, "jurisdiction" TEXT, "region" TEXT,
  "index_type" TEXT NOT NULL, "basket_type" TEXT NOT NULL, "status" TEXT NOT NULL, "start_date" DATE, "end_date" DATE,
  "base_date" DATE, "base_value" DECIMAL(24,8), "methodology_url" TEXT, "official_source_url" TEXT,
  "license_status" TEXT NOT NULL, "verification_status" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "currency_index_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "currency_index_profiles_symbol_key" ON "currency_index_profiles"("symbol");
CREATE INDEX "currency_index_profiles_index_type_status_idx" ON "currency_index_profiles"("index_type", "status");

CREATE TABLE "currency_index_observation_meta" (
  "id" UUID NOT NULL, "symbol" TEXT NOT NULL, "observation_date" DATE NOT NULL, "observation_type" TEXT NOT NULL,
  "source" TEXT NOT NULL, "source_type" TEXT NOT NULL, "source_record_id" TEXT, "source_url" TEXT, "as_of_date" DATE NOT NULL,
  "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "verification_status" TEXT NOT NULL,
  "license_status" TEXT NOT NULL, "quality_status" TEXT NOT NULL,
  CONSTRAINT "currency_index_observation_meta_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "currency_index_observation_meta_symbol_observation_date_key" ON "currency_index_observation_meta"("symbol", "observation_date");
CREATE INDEX "currency_index_observation_meta_symbol_observation_date_idx" ON "currency_index_observation_meta"("symbol", "observation_date");

CREATE TABLE "currency_index_methodologies" (
  "id" UUID NOT NULL, "symbol" TEXT NOT NULL, "provider" TEXT NOT NULL, "index_objective" TEXT NOT NULL,
  "basket_definition" TEXT NOT NULL, "constituent_currencies" JSONB NOT NULL, "weighting_method" TEXT NOT NULL,
  "weight_source" TEXT NOT NULL, "base_date" DATE, "base_value" DECIMAL(24,8), "rebalance_frequency" TEXT NOT NULL,
  "calculation_frequency" TEXT, "methodology_url" TEXT NOT NULL, "effective_date" DATE, "source" TEXT NOT NULL,
  "license_status" TEXT NOT NULL, "verification_status" TEXT NOT NULL, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "currency_index_methodologies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "currency_index_methodologies_symbol_key" ON "currency_index_methodologies"("symbol");

CREATE TABLE "currency_index_constituents" (
  "id" UUID NOT NULL, "symbol" TEXT NOT NULL, "currency_code" TEXT NOT NULL, "weight" DECIMAL(18,10),
  "as_of_date" DATE NOT NULL, "effective_from" DATE, "effective_to" DATE, "source" TEXT NOT NULL,
  "source_record_id" TEXT, "license_status" TEXT NOT NULL, "derivation_type" TEXT NOT NULL,
  CONSTRAINT "currency_index_constituents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "currency_index_constituents_symbol_currency_code_as_of_date_key" ON "currency_index_constituents"("symbol", "currency_code", "as_of_date");
CREATE INDEX "currency_index_constituents_symbol_as_of_date_idx" ON "currency_index_constituents"("symbol", "as_of_date");

CREATE TABLE "currency_index_events" (
  "id" UUID NOT NULL, "symbol" TEXT NOT NULL, "event_type" TEXT NOT NULL, "announcement_date" DATE,
  "effective_date" DATE NOT NULL, "source" TEXT NOT NULL, "source_record_id" TEXT, "source_url" TEXT,
  "verification_status" TEXT NOT NULL, CONSTRAINT "currency_index_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "currency_index_events_symbol_event_type_effective_date_key" ON "currency_index_events"("symbol", "event_type", "effective_date");
CREATE INDEX "currency_index_events_symbol_effective_date_idx" ON "currency_index_events"("symbol", "effective_date");

CREATE TABLE "currency_index_analytics" (
  "id" UUID NOT NULL, "symbol" TEXT NOT NULL, "as_of_date" DATE NOT NULL, "metric" TEXT NOT NULL,
  "value" DECIMAL(24,10) NOT NULL, "semantic" TEXT NOT NULL, "source" TEXT NOT NULL,
  "quality_status" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "currency_index_analytics_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "currency_index_analytics_symbol_as_of_date_metric_key" ON "currency_index_analytics"("symbol", "as_of_date", "metric");
CREATE INDEX "currency_index_analytics_symbol_as_of_date_idx" ON "currency_index_analytics"("symbol", "as_of_date");

CREATE TABLE "currency_index_incremental_state" (
  "symbol" TEXT NOT NULL, "last_source_date" DATE, "last_canonical_date" DATE, "last_source_state" TEXT,
  "last_processed_record" TEXT, "last_successful_run" TIMESTAMP(3), "next_eligible_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "currency_index_incremental_state_pkey" PRIMARY KEY ("symbol")
);

CREATE TABLE "currency_index_coverage" (
  "symbol" TEXT NOT NULL, "identity_available" BOOLEAN NOT NULL, "current_available" BOOLEAN NOT NULL,
  "history_available" BOOLEAN NOT NULL, "first_date" DATE, "last_date" DATE, "observation_count" INTEGER NOT NULL,
  "methodology_available" BOOLEAN NOT NULL, "basket_available" BOOLEAN NOT NULL, "weights_available" BOOLEAN NOT NULL,
  "performance_available" BOOLEAN NOT NULL, "source_verified" BOOLEAN NOT NULL, "license_status" TEXT NOT NULL,
  "coverage_status" TEXT NOT NULL, "last_checked_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "currency_index_coverage_pkey" PRIMARY KEY ("symbol")
);
