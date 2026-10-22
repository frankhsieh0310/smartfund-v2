CREATE TABLE IF NOT EXISTS futures_yahoo_symbol_mappings (
  id UUID PRIMARY KEY,
  root_id UUID NOT NULL REFERENCES futures_product_roots(id),
  yahoo_symbol TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  exchange TEXT NOT NULL,
  mapping_status TEXT NOT NULL DEFAULT 'VERIFIED_EXACT_ROOT',
  source_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS futures_root_market_observations (
  id UUID PRIMARY KEY,
  root_id UUID NOT NULL REFERENCES futures_product_roots(id),
  yahoo_symbol TEXT NOT NULL,
  observed_date DATE NOT NULL,
  open NUMERIC(24,8),
  high NUMERIC(24,8),
  low NUMERIC(24,8),
  close NUMERIC(24,8),
  adjusted_close NUMERIC(24,8),
  volume BIGINT,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_grain TEXT NOT NULL DEFAULT 'VENDOR_CONTINUOUS_ROOT_SERIES',
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(yahoo_symbol, observed_date)
);

CREATE INDEX IF NOT EXISTS futures_root_market_observations_root_date_idx ON futures_root_market_observations(root_id, observed_date);
