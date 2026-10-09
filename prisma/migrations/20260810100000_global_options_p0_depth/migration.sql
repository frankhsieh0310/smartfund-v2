ALTER TABLE "option_contracts"
  ADD COLUMN IF NOT EXISTS "stock_id" TEXT,
  ADD COLUMN IF NOT EXISTS "etf_id" TEXT,
  ADD COLUMN IF NOT EXISTS "global_index_id" TEXT,
  ADD COLUMN IF NOT EXISTS "futures_contract_id" UUID,
  ADD COLUMN IF NOT EXISTS "option_product_id" TEXT,
  ADD COLUMN IF NOT EXISTS "exercise_style" TEXT,
  ADD COLUMN IF NOT EXISTS "settlement_style" TEXT,
  ADD COLUMN IF NOT EXISTS "deliverable" JSONB,
  ADD COLUMN IF NOT EXISTS "listing_date" DATE,
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "expiration_class" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "source_identity" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "option_observations"
  ADD COLUMN IF NOT EXISTS "delta" DECIMAL(24,10),
  ADD COLUMN IF NOT EXISTS "gamma" DECIMAL(24,10),
  ADD COLUMN IF NOT EXISTS "theta" DECIMAL(24,10),
  ADD COLUMN IF NOT EXISTS "vega" DECIMAL(24,10),
  ADD COLUMN IF NOT EXISTS "rho" DECIMAL(24,10),
  ADD COLUMN IF NOT EXISTS "greeks_source" TEXT,
  ADD COLUMN IF NOT EXISTS "greeks_method" TEXT,
  ADD COLUMN IF NOT EXISTS "midpoint" DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS "bid_ask_spread" DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS "spread_pct" DECIMAL(24,10),
  ADD COLUMN IF NOT EXISTS "liquidity_state" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "liquidity_rule" TEXT,
  ADD COLUMN IF NOT EXISTS "days_to_expiry" INTEGER,
  ADD COLUMN IF NOT EXISTS "settlement_price" DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS "settlement_date" DATE,
  ADD COLUMN IF NOT EXISTS "settlement_source" TEXT,
  ADD COLUMN IF NOT EXISTS "source_url" TEXT,
  ADD COLUMN IF NOT EXISTS "source_record_id" TEXT,
  ADD COLUMN IF NOT EXISTS "source_timestamp" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "retrieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "payload_checksum" TEXT,
  ADD COLUMN IF NOT EXISTS "verification_status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "freshness_status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "source_delay" TEXT NOT NULL DEFAULT 'DELAYED';

DROP INDEX IF EXISTS "option_observations_contract_id_observed_at_key";
CREATE UNIQUE INDEX IF NOT EXISTS "option_observations_contract_id_observed_at_source_key" ON "option_observations"("contract_id", "observed_at", "source");
CREATE INDEX IF NOT EXISTS "option_contracts_stock_id_idx" ON "option_contracts"("stock_id");
CREATE INDEX IF NOT EXISTS "option_contracts_etf_id_idx" ON "option_contracts"("etf_id");
CREATE INDEX IF NOT EXISTS "option_contracts_global_index_id_idx" ON "option_contracts"("global_index_id");
CREATE INDEX IF NOT EXISTS "option_contracts_futures_contract_id_idx" ON "option_contracts"("futures_contract_id");

DO $$ BEGIN
  ALTER TABLE "option_contracts" ADD CONSTRAINT "option_contracts_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "option_contracts" ADD CONSTRAINT "option_contracts_etf_id_fkey" FOREIGN KEY ("etf_id") REFERENCES "etfs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "option_contracts" ADD CONSTRAINT "option_contracts_global_index_id_fkey" FOREIGN KEY ("global_index_id") REFERENCES "global_index_registry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "option_contracts" ADD CONSTRAINT "option_contracts_futures_contract_id_fkey" FOREIGN KEY ("futures_contract_id") REFERENCES "futures_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "option_latest_observations" (
  "contract_id" UUID NOT NULL PRIMARY KEY REFERENCES "option_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "observation_id" UUID NOT NULL UNIQUE REFERENCES "option_observations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "freshness_status" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "option_latest_observations_observed_at_idx" ON "option_latest_observations"("observed_at");

CREATE TABLE IF NOT EXISTS "option_lifecycle_events" (
  "id" UUID NOT NULL PRIMARY KEY,
  "contract_id" UUID NOT NULL REFERENCES "option_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "event_type" TEXT NOT NULL,
  "effective_at" TIMESTAMP(3) NOT NULL,
  "source" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "option_lifecycle_events_contract_id_event_type_effective_at_key" ON "option_lifecycle_events"("contract_id","event_type","effective_at");
CREATE INDEX IF NOT EXISTS "option_lifecycle_events_effective_at_idx" ON "option_lifecycle_events"("effective_at");

CREATE TABLE IF NOT EXISTS "option_contract_adjustments" (
  "id" UUID NOT NULL PRIMARY KEY,
  "contract_id" UUID NOT NULL REFERENCES "option_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "adjustment_type" TEXT NOT NULL,
  "effective_date" DATE NOT NULL,
  "details" JSONB,
  "source" TEXT NOT NULL,
  "verification_status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "option_contract_adjustments_contract_id_adjustment_type_effective_date_key" ON "option_contract_adjustments"("contract_id","adjustment_type","effective_date");

UPDATE "option_contracts" SET
  "global_index_id"='sp-500',
  "underlying_identity"='{"model":"GlobalIndexRegistry","id":"sp-500","resolution":"EXACT"}'::jsonb,
  "source_identity"='{"authority":"Cboe Global Markets","source":"CBOE_DELAYED_OPTIONS"}'::jsonb,
  "status"=CASE WHEN "expiration" < CURRENT_DATE THEN 'EXPIRED' ELSE 'ACTIVE' END
WHERE "underlying"='SPX';

INSERT INTO "option_lifecycle_events" ("id","contract_id","event_type","effective_at","source","verification_status")
SELECT gen_random_uuid(),"id",'EXPIRED',"expiration"::timestamp,'CONTRACT_EXPIRATION','VERIFIED_DERIVED'
FROM "option_contracts" WHERE "expiration" < CURRENT_DATE
ON CONFLICT ("contract_id","event_type","effective_at") DO NOTHING;
