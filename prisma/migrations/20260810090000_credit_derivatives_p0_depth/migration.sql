ALTER TABLE "credit_derivative_observations"
  ADD COLUMN "observation_type" TEXT NOT NULL DEFAULT 'TRANSACTION',
  ADD COLUMN "source_record_id" TEXT,
  ADD COLUMN "verification_status" TEXT NOT NULL DEFAULT 'VERIFIED_OFFICIAL',
  ADD COLUMN "retrieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "checksum" TEXT;

CREATE TABLE "credit_reference_entities" (
  "id" UUID NOT NULL, "official_name" TEXT NOT NULL, "entity_type" TEXT NOT NULL,
  "country" TEXT, "jurisdiction" TEXT, "sector" TEXT, "industry" TEXT, "lei" TEXT,
  "external_identifiers" JSONB, "status" TEXT NOT NULL, "source" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "credit_reference_entities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "credit_reference_entities_source_official_name_key" ON "credit_reference_entities"("source","official_name");

CREATE TABLE "credit_reference_obligations" (
  "id" UUID NOT NULL, "reference_entity_id" UUID, "obligation_type" TEXT NOT NULL,
  "isin" TEXT, "cusip" TEXT, "currency" TEXT, "seniority" TEXT, "maturity_date" DATE,
  "status" TEXT NOT NULL, "source" TEXT NOT NULL, "verification_status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "credit_reference_obligations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "credit_reference_obligations_source_isin_key" ON "credit_reference_obligations"("source","isin");

CREATE TABLE "credit_derivative_instruments" (
  "id" UUID NOT NULL, "upi" TEXT NOT NULL, "product_type" TEXT NOT NULL,
  "reference_entity_id" UUID, "reference_obligation_id" UUID, "currency" TEXT, "tenor" TEXT,
  "seniority" TEXT, "restructuring_convention" TEXT, "coupon" DECIMAL(24,10),
  "upfront_convention" TEXT, "recovery_convention" TEXT, "effective_date" DATE, "maturity_date" DATE,
  "source_taxonomy" TEXT, "status" TEXT NOT NULL, "source" TEXT NOT NULL, "verification_status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "credit_derivative_instruments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "credit_derivative_instruments_upi_key" ON "credit_derivative_instruments"("upi");

CREATE TABLE "credit_derivative_transactions" (
  "id" UUID NOT NULL, "instrument_id" UUID NOT NULL, "market" TEXT NOT NULL, "business_date" DATE NOT NULL,
  "execution_timestamp" TIMESTAMP(3), "dissemination_timestamp" TIMESTAMP(3), "action_type" TEXT, "event_type" TEXT,
  "notional" DECIMAL(30,6), "notional_currency" TEXT, "transaction_price" DECIMAL(30,10),
  "transaction_price_type" TEXT, "transaction_spread_leg_1" DECIMAL(30,10), "transaction_spread_leg_2" DECIMAL(30,10),
  "source" TEXT NOT NULL, "source_url" TEXT NOT NULL, "source_record_id" TEXT, "retrieved_at" TIMESTAMP(3) NOT NULL,
  "source_version" TEXT, "checksum" TEXT, "verification_status" TEXT NOT NULL,
  "observation_type" TEXT NOT NULL DEFAULT 'TRANSACTION', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "credit_derivative_transactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "credit_derivative_transactions_source_source_record_id_key" ON "credit_derivative_transactions"("source","source_record_id");
CREATE INDEX "credit_derivative_transactions_business_date_instrument_id_idx" ON "credit_derivative_transactions"("business_date","instrument_id");

CREATE TABLE "credit_derivative_market_quotes" (
  "id" UUID NOT NULL, "instrument_id" UUID NOT NULL, "tenor" TEXT, "as_of" TIMESTAMP(3) NOT NULL,
  "bid_spread" DECIMAL(24,10), "ask_spread" DECIMAL(24,10), "mid_spread" DECIMAL(24,10),
  "upfront_bid" DECIMAL(24,10), "upfront_ask" DECIMAL(24,10), "upfront_mid" DECIMAL(24,10),
  "recovery_assumption" DECIMAL(12,8), "quote_currency" TEXT, "source" TEXT NOT NULL, "source_url" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL, "freshness_status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "credit_derivative_market_quotes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "credit_derivative_market_quotes_instrument_id_tenor_as_of_source_key" ON "credit_derivative_market_quotes"("instrument_id","tenor","as_of","source");

CREATE TABLE "credit_derivative_index_series" (
  "id" UUID NOT NULL, "family" TEXT NOT NULL, "series" TEXT NOT NULL, "version" TEXT NOT NULL, "tenor" TEXT NOT NULL,
  "coupon" DECIMAL(24,10), "roll_date" DATE, "effective_date" DATE, "maturity_date" DATE,
  "source" TEXT NOT NULL, "verification_status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "credit_derivative_index_series_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "credit_derivative_index_series_family_series_version_tenor_key" ON "credit_derivative_index_series"("family","series","version","tenor");

CREATE TABLE "credit_derivative_index_constituents" (
  "id" UUID NOT NULL, "index_series_id" UUID NOT NULL, "reference_entity_id" UUID NOT NULL, "weight" DECIMAL(18,12),
  "effective_date" DATE NOT NULL, "end_date" DATE, "source" TEXT NOT NULL, "verification_status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "credit_derivative_index_constituents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "credit_derivative_index_constituents_series_entity_effective_key" ON "credit_derivative_index_constituents"("index_series_id","reference_entity_id","effective_date");

CREATE TABLE "credit_derivative_lifecycle_events" (
  "id" UUID NOT NULL, "instrument_id" UUID, "event_type" TEXT NOT NULL, "announcement_date" DATE NOT NULL,
  "effective_date" DATE, "auction_date" DATE, "recovery_price" DECIMAL(24,10), "source" TEXT NOT NULL,
  "source_url" TEXT NOT NULL, "verification_status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "credit_derivative_lifecycle_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "credit_derivative_license_register" (
  "id" UUID NOT NULL, "domain" TEXT NOT NULL, "provider" TEXT NOT NULL, "required_data" JSONB NOT NULL,
  "license_status" TEXT NOT NULL, "redistribution_status" TEXT NOT NULL, "automation_status" TEXT NOT NULL,
  "notes" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "credit_derivative_license_register_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "credit_derivative_license_register_domain_key" ON "credit_derivative_license_register"("domain");

ALTER TABLE "credit_reference_obligations" ADD CONSTRAINT "credit_reference_obligations_reference_entity_id_fkey" FOREIGN KEY ("reference_entity_id") REFERENCES "credit_reference_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "credit_derivative_instruments" ADD CONSTRAINT "credit_derivative_instruments_reference_entity_id_fkey" FOREIGN KEY ("reference_entity_id") REFERENCES "credit_reference_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "credit_derivative_instruments" ADD CONSTRAINT "credit_derivative_instruments_reference_obligation_id_fkey" FOREIGN KEY ("reference_obligation_id") REFERENCES "credit_reference_obligations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "credit_derivative_transactions" ADD CONSTRAINT "credit_derivative_transactions_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "credit_derivative_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_derivative_market_quotes" ADD CONSTRAINT "credit_derivative_market_quotes_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "credit_derivative_instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_derivative_index_constituents" ADD CONSTRAINT "credit_derivative_index_constituents_index_series_id_fkey" FOREIGN KEY ("index_series_id") REFERENCES "credit_derivative_index_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_derivative_index_constituents" ADD CONSTRAINT "credit_derivative_index_constituents_reference_entity_id_fkey" FOREIGN KEY ("reference_entity_id") REFERENCES "credit_reference_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_derivative_lifecycle_events" ADD CONSTRAINT "credit_derivative_lifecycle_events_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "credit_derivative_instruments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
