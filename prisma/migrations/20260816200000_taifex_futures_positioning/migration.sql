CREATE TABLE IF NOT EXISTS "taifex_futures_positioning_observations" (
  "id" uuid PRIMARY KEY,
  "root_id" uuid NOT NULL REFERENCES "futures_product_roots"("id") ON DELETE CASCADE,
  "report_date" date NOT NULL,
  "official_product_code" text NOT NULL,
  "official_product_name" text NOT NULL,
  "source_category" text NOT NULL,
  "standardized_category" text NOT NULL,
  "trading_long" bigint,
  "trading_short" bigint,
  "trading_net" bigint,
  "open_interest_long" bigint NOT NULL,
  "open_interest_short" bigint NOT NULL,
  "open_interest_net" bigint NOT NULL,
  "source" text NOT NULL,
  "source_url" text NOT NULL,
  "source_record_id" text NOT NULL,
  "source_checksum" text NOT NULL,
  "retrieved_at" timestamptz NOT NULL,
  "published_at" timestamptz,
  "known_at" timestamptz NOT NULL,
  "known_at_precision" text NOT NULL,
  "verification_status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "taifex_futures_positioning_identity" UNIQUE("report_date","official_product_code","standardized_category")
);
CREATE INDEX IF NOT EXISTS "taifex_futures_positioning_root_date_idx" ON "taifex_futures_positioning_observations"("root_id","report_date");

CREATE TABLE IF NOT EXISTS "taifex_futures_positioning_analytics" (
  "observation_id" uuid PRIMARY KEY REFERENCES "taifex_futures_positioning_observations"("id") ON DELETE CASCADE,
  "root_id" uuid NOT NULL REFERENCES "futures_product_roots"("id") ON DELETE CASCADE,
  "report_date" date NOT NULL,
  "standardized_category" text NOT NULL,
  "net_position" bigint NOT NULL,
  "net_change" bigint,
  "net_pct_oi" numeric(20,10),
  "percentile_full_history" numeric(10,8),
  "zscore_full_history" numeric(20,10),
  "crowding_state" text,
  "formula_version" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "taifex_futures_positioning_analytics_root_date_idx" ON "taifex_futures_positioning_analytics"("root_id","report_date");
