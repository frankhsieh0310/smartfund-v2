CREATE TABLE "carbon_programs" (
  "id" TEXT PRIMARY KEY, "official_name" TEXT NOT NULL, "short_name" TEXT NOT NULL, "jurisdiction" TEXT NOT NULL,
  "country_or_region" TEXT NOT NULL, "region" TEXT NOT NULL, "program_type" TEXT NOT NULL,
  "administrator" TEXT NOT NULL, "regulator" TEXT NOT NULL, "compliance_market" BOOLEAN NOT NULL DEFAULT TRUE,
  "auction_supported" BOOLEAN NOT NULL, "secondary_trading_supported" BOOLEAN NOT NULL,
  "futures_supported" BOOLEAN NOT NULL, "start_date" DATE, "end_date" DATE, "status" TEXT NOT NULL,
  "official_url" TEXT NOT NULL, "verification_status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "carbon_instruments" (
  "id" TEXT PRIMARY KEY, "program_id" TEXT NOT NULL REFERENCES "carbon_programs"("id"),
  "official_name" TEXT NOT NULL, "symbol_code" TEXT, "instrument_type" TEXT NOT NULL,
  "allowance_type" TEXT NOT NULL, "vintage" TEXT, "currency" TEXT, "unit" TEXT NOT NULL,
  "venue" TEXT, "status" TEXT NOT NULL, "start_date" DATE, "end_date" DATE, "source" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "carbon_instruments_program_name_vintage_key" ON "carbon_instruments"("program_id", "official_name", "vintage");
CREATE TABLE "carbon_auction_events" (
  "id" TEXT PRIMARY KEY, "program_id" TEXT NOT NULL REFERENCES "carbon_programs"("id"),
  "instrument_id" TEXT NOT NULL REFERENCES "carbon_instruments"("id"), "auction_date" DATE NOT NULL,
  "auction_type" TEXT, "auction_name" TEXT, "vintage" TEXT, "offered_volume" DECIMAL(24,6),
  "sold_volume" DECIMAL(24,6), "clearing_price" DECIMAL(24,6), "currency" TEXT NOT NULL,
  "unit" TEXT NOT NULL, "bid_coverage_ratio" DECIMAL(18,6), "number_of_participants" INTEGER,
  "status" TEXT NOT NULL, "source" TEXT NOT NULL, "source_record_id" TEXT, "source_version" TEXT,
  "retrieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "revision_status" TEXT NOT NULL DEFAULT 'CURRENT',
  "verification_status" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "carbon_auction_events_source_record_key" ON "carbon_auction_events"("program_id", "source", "source_record_id");
CREATE INDEX "carbon_auction_events_program_date_idx" ON "carbon_auction_events"("program_id", "auction_date");
ALTER TABLE "carbon_market_observations" ADD COLUMN "program_id" TEXT REFERENCES "carbon_programs"("id"),
  ADD COLUMN "carbon_instrument_id" TEXT REFERENCES "carbon_instruments"("id"),
  ADD COLUMN "auction_event_id" TEXT REFERENCES "carbon_auction_events"("id"),
  ADD COLUMN "compliance_year" INTEGER, ADD COLUMN "vintage" TEXT, ADD COLUMN "publication_date" DATE,
  ADD COLUMN "source_version" TEXT, ADD COLUMN "retrieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "revision_status" TEXT NOT NULL DEFAULT 'CURRENT';
DROP INDEX "carbon_market_observations_market_instrument_observation_date_metric_type_key";
CREATE UNIQUE INDEX "carbon_market_observations_market_instrument_date_metric_auction_key"
  ON "carbon_market_observations"("market", "instrument", "observation_date", "metric_type", "auction_event_id");
CREATE TABLE "carbon_futures_mappings" (
  "id" UUID PRIMARY KEY, "carbon_instrument_id" TEXT NOT NULL REFERENCES "carbon_instruments"("id"),
  "futures_contract_id" UUID REFERENCES "futures_contracts"("id"), "mapping_type" TEXT NOT NULL, "evidence" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "carbon_futures_mappings_instrument_contract_key" ON "carbon_futures_mappings"("carbon_instrument_id", "futures_contract_id");
CREATE TABLE "carbon_data_licenses" (
  "id" UUID PRIMARY KEY, "provider" TEXT NOT NULL, "market" TEXT NOT NULL, "instrument" TEXT NOT NULL,
  "data_domain" TEXT NOT NULL, "license_status" TEXT NOT NULL, "redistribution_status" TEXT NOT NULL,
  "automation_status" TEXT NOT NULL, "notes" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "carbon_data_licenses_identity_key" ON "carbon_data_licenses"("provider", "market", "instrument", "data_domain");
