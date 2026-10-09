CREATE TABLE IF NOT EXISTS futures_option_products (
  id UUID PRIMARY KEY,
  exchange TEXT NOT NULL,
  official_product_id TEXT NOT NULL,
  official_product_code TEXT NOT NULL,
  official_product_name TEXT NOT NULL,
  futures_root_id UUID NOT NULL REFERENCES futures_product_roots(id),
  relationship_type TEXT NOT NULL CHECK (relationship_type = 'FUTURES_ROOT'),
  multiplier TEXT,
  settlement_style TEXT,
  exercise_style TEXT,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  license_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(exchange, official_product_id)
);
CREATE INDEX IF NOT EXISTS futures_option_products_root_idx ON futures_option_products(futures_root_id);
