-- Function 2 candidate storage: Taiwan Active ETF daily holdings, sourced only from each issuer's own
-- official public API (Nomura, UPAMC, ...), never third-party. One shared schema for every issuer —
-- no per-issuer tables. NOT applied this round (candidate only, validated in a rollback transaction).
--
-- Identity: (etf_code, data_date) is the unique key for a snapshot. A same-day rerun upserts in place
-- (no duplicate snapshot rows); a new trading day always INSERTs a new snapshot row — history is never
-- overwritten.

CREATE TABLE IF NOT EXISTS "active_etf_daily_snapshots" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "etf_code" text NOT NULL,
  "issuer" text NOT NULL,
  "data_date" date NOT NULL,
  "announcement_date" date NOT NULL,
  "fund_nav" numeric NOT NULL,
  "outstanding_units" numeric NOT NULL,
  "source" text NOT NULL,
  "retrieved_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "active_etf_daily_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "active_etf_daily_snapshots_etf_date_key" UNIQUE ("etf_code", "data_date")
);

CREATE TABLE IF NOT EXISTS "active_etf_daily_holdings" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "snapshot_id" uuid NOT NULL REFERENCES "active_etf_daily_snapshots"("id") ON DELETE CASCADE,
  "security_code" text NOT NULL,
  "security_name" text NOT NULL,
  "total_shares" numeric NOT NULL,
  "weight" numeric NOT NULL,
  "rank" integer,
  "security_id" text,
  "source" text NOT NULL,
  CONSTRAINT "active_etf_daily_holdings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "active_etf_daily_holdings_snapshot_code_key" UNIQUE ("snapshot_id", "security_code")
);

CREATE TABLE IF NOT EXISTS "active_etf_daily_futures" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "snapshot_id" uuid NOT NULL REFERENCES "active_etf_daily_snapshots"("id") ON DELETE CASCADE,
  "contract_code" text NOT NULL,
  "contract_month" text,
  "contracts" numeric NOT NULL,
  "weight" numeric NOT NULL,
  CONSTRAINT "active_etf_daily_futures_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "active_etf_daily_futures_snapshot_code_key" UNIQUE ("snapshot_id", "contract_code")
);

CREATE INDEX IF NOT EXISTS "active_etf_daily_snapshots_etf_date_idx" ON "active_etf_daily_snapshots" ("etf_code", "data_date" DESC);
CREATE INDEX IF NOT EXISTS "active_etf_daily_holdings_snapshot_idx" ON "active_etf_daily_holdings" ("snapshot_id");
CREATE INDEX IF NOT EXISTS "active_etf_daily_futures_snapshot_idx" ON "active_etf_daily_futures" ("snapshot_id");
