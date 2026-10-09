CREATE TABLE IF NOT EXISTS futures_margin_requirements (
  id UUID PRIMARY KEY,
  root_id UUID NOT NULL REFERENCES futures_product_roots(id),
  contract_id UUID REFERENCES futures_contracts(id),
  margin_type TEXT NOT NULL,
  participant_type TEXT NOT NULL,
  amount NUMERIC(24,8) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL,
  effective_date DATE NOT NULL,
  published_at TIMESTAMPTZ,
  known_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(root_id, contract_id, margin_type, participant_type, effective_date, source)
);
CREATE INDEX IF NOT EXISTS futures_margin_requirements_root_date_idx ON futures_margin_requirements(root_id,effective_date);

CREATE TABLE IF NOT EXISTS futures_underlying_relationships (
  id UUID PRIMARY KEY,
  root_id UUID NOT NULL REFERENCES futures_product_roots(id),
  relationship_type TEXT NOT NULL,
  underlying_type TEXT NOT NULL,
  canonical_target_type TEXT,
  canonical_target_id UUID,
  official_underlying_code TEXT,
  official_underlying_name TEXT NOT NULL,
  effective_from DATE,
  effective_to DATE,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(root_id, relationship_type, official_underlying_name)
);
