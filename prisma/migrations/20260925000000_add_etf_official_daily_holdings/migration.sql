-- Function 2: Taiwan ETF Official Daily Holdings Engine. Sourced only from each issuer's own official
-- PCF/holdings page or API (17 confirmed issuers), never MoneyDJ, never a third-party aggregator. One
-- shared schema for every issuer and every asset type (active + passive) — no issuer-specific tables.
--
-- Identity: (etf_code, data_date) is the unique key for a snapshot. A same-day rerun upserts in place
-- (no duplicate snapshot rows); a new trading day always INSERTs a new snapshot row — history is never
-- overwritten. NOT applied to production this round (candidate/typecheck-only).

CREATE TABLE IF NOT EXISTS "etf_official_daily_snapshots" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "etf_code" text NOT NULL,
  "issuer" text NOT NULL,
  "asset_type" text NOT NULL,
  "data_date" date NOT NULL,
  "announcement_date" date NOT NULL,
  "fund_nav" numeric(24,4) NOT NULL,
  "outstanding_units" numeric(24,4) NOT NULL,
  "source" text NOT NULL,
  "retrieved_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "etf_official_daily_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "etf_official_daily_snapshots_etf_date_key" UNIQUE ("etf_code", "data_date")
);

-- position_amount is always in the position's OWN official unit — SHARES for equity, PAR_VALUE for
-- bonds (never converted to lots), CONTRACTS for futures/options. position_type/position_unit travel
-- per-row so a single (multi-asset) snapshot can legitimately mix units.
CREATE TABLE IF NOT EXISTS "etf_official_daily_positions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "snapshot_id" uuid NOT NULL REFERENCES "etf_official_daily_snapshots"("id") ON DELETE CASCADE,
  "security_code" text NOT NULL,
  "security_name" text NOT NULL,
  "position_type" text NOT NULL,
  "position_amount" numeric(28,4) NOT NULL,
  "position_unit" text NOT NULL,
  "weight" numeric(10,4) NOT NULL,
  "rank" integer,
  "canonical_security_id" text,
  "source" text NOT NULL,
  CONSTRAINT "etf_official_daily_positions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "etf_official_daily_positions_snapshot_code_key" UNIQUE ("snapshot_id", "security_code")
);

CREATE INDEX IF NOT EXISTS "etf_official_daily_snapshots_etf_date_idx" ON "etf_official_daily_snapshots" ("etf_code", "data_date" DESC);
CREATE INDEX IF NOT EXISTS "etf_official_daily_positions_snapshot_idx" ON "etf_official_daily_positions" ("snapshot_id");
