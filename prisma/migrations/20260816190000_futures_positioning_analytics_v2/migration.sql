ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "root_id" uuid REFERENCES "futures_product_roots"("id") ON DELETE SET NULL;
ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "mapping_status" text NOT NULL DEFAULT 'ROOT_NOT_FOUND';
ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "standardized_category" text;
ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "gross_position" bigint;
ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "long_short_ratio" numeric(30,12);
ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "percentile_full_history" numeric(10,8);
ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "zscore_1y" numeric(20,10);
ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "zscore_3y" numeric(20,10);
ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "zscore_5y" numeric(20,10);
ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "crowding_state" text;
ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "positioning_change_state" text;
ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "known_at" timestamptz;
ALTER TABLE "futures_positioning_analytics" ADD COLUMN IF NOT EXISTS "known_at_precision" text NOT NULL DEFAULT 'RETRIEVED_AT_NOT_RELEASE_TIMESTAMP';
CREATE INDEX IF NOT EXISTS "futures_positioning_analytics_root_date_idx" ON "futures_positioning_analytics"("root_id","as_of_date");

CREATE TABLE IF NOT EXISTS "futures_cot_root_mappings" (
  "cftc_contract_market_code" text PRIMARY KEY,
  "root_id" uuid REFERENCES "futures_product_roots"("id") ON DELETE SET NULL,
  "exchange" text NOT NULL,
  "root_symbol" text NOT NULL,
  "mapping_status" text NOT NULL,
  "source" text NOT NULL DEFAULT 'DETERMINISTIC_CFTC_CODE_CROSSWALK',
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
