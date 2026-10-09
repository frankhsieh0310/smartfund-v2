CREATE TABLE IF NOT EXISTS "futures_positioning_markets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "cftc_contract_market_code" TEXT NOT NULL,
  "cftc_market_code" TEXT,
  "cftc_commodity_code" TEXT,
  "market_name" TEXT NOT NULL,
  "exchange" TEXT,
  "contract_unit" TEXT,
  "currency" TEXT,
  "jurisdiction" TEXT NOT NULL DEFAULT 'US',
  "asset_family" TEXT NOT NULL,
  "commodity_group" TEXT,
  "active_status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "start_date" DATE,
  "end_date" DATE,
  "report_availability" TEXT[] NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "futures_positioning_markets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "futures_positioning_markets_contract_code_key" UNIQUE ("cftc_contract_market_code")
);

ALTER TABLE "futures_positioning_observations" ADD COLUMN IF NOT EXISTS "market_id" UUID;
ALTER TABLE "futures_positioning_observations" ADD COLUMN IF NOT EXISTS "report_scope" TEXT NOT NULL DEFAULT 'FUTURES_ONLY';
ALTER TABLE "futures_positioning_observations" ADD COLUMN IF NOT EXISTS "source_url" TEXT;
ALTER TABLE "futures_positioning_observations" ADD COLUMN IF NOT EXISTS "source_file" TEXT;
ALTER TABLE "futures_positioning_observations" ADD COLUMN IF NOT EXISTS "retrieved_at" TIMESTAMP(3);
ALTER TABLE "futures_positioning_observations" ADD COLUMN IF NOT EXISTS "parser_version" TEXT;
ALTER TABLE "futures_positioning_observations" ADD COLUMN IF NOT EXISTS "checksum" TEXT;
ALTER TABLE "futures_positioning_observations" ADD COLUMN IF NOT EXISTS "verification_state" TEXT NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE "futures_positioning_observations" ADD COLUMN IF NOT EXISTS "net_pct_oi" DECIMAL(20,10);
CREATE INDEX IF NOT EXISTS "futures_positioning_observations_market_id_date_idx" ON "futures_positioning_observations"("market_id", "report_date");
DO $$ BEGIN
  ALTER TABLE "futures_positioning_observations" ADD CONSTRAINT "futures_positioning_observations_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "futures_positioning_markets"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "futures_positioning_archive_checkpoints" (
  "archive_id" TEXT NOT NULL,
  "report_type" TEXT NOT NULL,
  "report_year" INTEGER NOT NULL,
  "parser_version" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "rows_parsed" INTEGER NOT NULL DEFAULT 0,
  "rows_valid" INTEGER NOT NULL DEFAULT 0,
  "rows_invalid" INTEGER NOT NULL DEFAULT 0,
  "rows_inserted" INTEGER NOT NULL DEFAULT 0,
  "rows_no_op" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL,
  "last_processed_offset" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "futures_positioning_archive_checkpoints_pkey" PRIMARY KEY ("archive_id")
);
