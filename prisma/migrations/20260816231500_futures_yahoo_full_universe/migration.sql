ALTER TABLE futures_yahoo_symbol_mappings ADD COLUMN IF NOT EXISTS contract_name TEXT;
ALTER TABLE futures_yahoo_symbol_mappings ADD COLUMN IF NOT EXISTS contract_symbol TEXT;
ALTER TABLE futures_yahoo_symbol_mappings ADD COLUMN IF NOT EXISTS underlying_symbol TEXT;
ALTER TABLE futures_yahoo_symbol_mappings ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE futures_yahoo_symbol_mappings ADD COLUMN IF NOT EXISTS expiration_date DATE;
ALTER TABLE futures_yahoo_symbol_mappings ADD COLUMN IF NOT EXISTS field_disposition JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS futures_yahoo_current_snapshots (
  yahoo_symbol TEXT PRIMARY KEY,
  root_id UUID NOT NULL REFERENCES futures_product_roots(id),
  market_time TIMESTAMPTZ,
  last_price NUMERIC(24,8),
  previous_close NUMERIC(24,8),
  previous_settlement NUMERIC(24,8),
  change NUMERIC(24,8),
  change_percent NUMERIC(24,8),
  open NUMERIC(24,8),
  day_high NUMERIC(24,8),
  day_low NUMERIC(24,8),
  day_range TEXT,
  bid NUMERIC(24,8),
  ask NUMERIC(24,8),
  volume BIGINT,
  open_interest BIGINT,
  expiration_date DATE,
  contract_symbol TEXT,
  underlying_symbol TEXT,
  exchange TEXT,
  currency TEXT,
  market_state TEXT,
  source TEXT NOT NULL DEFAULT 'YAHOO',
  source_url TEXT NOT NULL,
  field_disposition JSONB NOT NULL DEFAULT '{}'::jsonb,
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
