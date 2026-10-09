CREATE TABLE IF NOT EXISTS bond_issuers (
  id TEXT PRIMARY KEY,
  official_name TEXT NOT NULL,
  issuer_type TEXT NOT NULL,
  country TEXT,
  verification_status TEXT NOT NULL DEFAULT 'VERIFIED_EXISTING',
  source_id TEXT NOT NULL DEFAULT 'SECURITIES_SECTOR',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (official_name, country)
);

CREATE TABLE IF NOT EXISTS bond_instruments (
  id TEXT PRIMARY KEY,
  security_id TEXT UNIQUE REFERENCES securities(id) ON DELETE RESTRICT,
  issuer_id TEXT REFERENCES bond_issuers(id) ON DELETE SET NULL,
  source_namespace TEXT NOT NULL,
  official_security_id TEXT NOT NULL,
  official_name TEXT NOT NULL,
  instrument_type TEXT NOT NULL,
  taxonomy TEXT NOT NULL DEFAULT 'UNKNOWN',
  government_subtype TEXT NOT NULL DEFAULT 'UNKNOWN',
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  isin TEXT,
  cusip TEXT,
  sedol TEXT,
  country TEXT NOT NULL,
  jurisdiction TEXT,
  currency TEXT NOT NULL,
  issue_date DATE,
  maturity_date DATE,
  status TEXT NOT NULL DEFAULT 'UNKNOWN',
  source_id TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  mapping_type TEXT NOT NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  source_updated_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (source_namespace, official_security_id),
  UNIQUE (identifier_type, identifier_value)
);

CREATE INDEX IF NOT EXISTS bond_instruments_country_idx ON bond_instruments(country);
CREATE INDEX IF NOT EXISTS bond_instruments_taxonomy_idx ON bond_instruments(taxonomy, government_subtype);
CREATE INDEX IF NOT EXISTS bond_instruments_maturity_idx ON bond_instruments(status, maturity_date);

CREATE TABLE IF NOT EXISTS bond_security_links (
  id TEXT PRIMARY KEY,
  security_id TEXT NOT NULL UNIQUE REFERENCES securities(id) ON DELETE CASCADE,
  bond_id TEXT NOT NULL UNIQUE REFERENCES bond_instruments(id) ON DELETE CASCADE,
  mapping_type TEXT NOT NULL,
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bond_terms (
  id TEXT PRIMARY KEY,
  bond_id TEXT NOT NULL UNIQUE REFERENCES bond_instruments(id) ON DELETE CASCADE,
  issue_date DATE,
  maturity_date DATE,
  coupon_rate NUMERIC(18,8),
  coupon_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  coupon_frequency INTEGER,
  face_value NUMERIC(30,6),
  currency TEXT NOT NULL,
  day_count_convention TEXT,
  seniority TEXT,
  secured_status TEXT,
  callable BOOLEAN,
  putable BOOLEAN,
  convertible BOOLEAN,
  inflation_linked BOOLEAN,
  outstanding_amount NUMERIC(30,6),
  as_of_date DATE,
  source_id TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bond_benchmark_series (
  id TEXT PRIMARY KEY,
  market_master_id TEXT UNIQUE,
  symbol TEXT NOT NULL UNIQUE,
  official_name TEXT NOT NULL,
  country TEXT,
  currency TEXT,
  benchmark_type TEXT NOT NULL,
  tenor TEXT,
  provider TEXT,
  source_id TEXT,
  start_date DATE,
  latest_date DATE,
  verification_status TEXT NOT NULL,
  history_quality_status TEXT NOT NULL,
  history_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_dates INTEGER NOT NULL DEFAULT 0,
  unexpected_zeros INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bond_freshness (
  id TEXT PRIMARY KEY,
  bond_id TEXT NOT NULL UNIQUE REFERENCES bond_instruments(id) ON DELETE CASCADE,
  latest_observation_date DATE,
  latest_retrieved_at TIMESTAMP,
  expected_frequency TEXT,
  freshness_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  source_status TEXT NOT NULL DEFAULT 'SOURCE_PENDING',
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bond_coverage_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  country TEXT NOT NULL,
  total_bond_identities INTEGER NOT NULL,
  verified_canonical INTEGER NOT NULL,
  terms_covered INTEGER NOT NULL,
  current_covered INTEGER NOT NULL,
  history_covered INTEGER NOT NULL,
  ge_1y INTEGER NOT NULL,
  ge_5y INTEGER NOT NULL,
  ge_10y INTEGER NOT NULL,
  source_blocked INTEGER NOT NULL,
  license_blocked INTEGER NOT NULL,
  identity_ready BOOLEAN NOT NULL,
  terms_ready BOOLEAN NOT NULL,
  current_ready BOOLEAN NOT NULL,
  history_ready BOOLEAN NOT NULL,
  source_ready BOOLEAN NOT NULL,
  freshness_ready BOOLEAN NOT NULL,
  analytics_ready BOOLEAN NOT NULL,
  professional_detail_ready BOOLEAN NOT NULL,
  missing_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (snapshot_date, country)
);

ALTER TABLE bond_market_observations ADD COLUMN IF NOT EXISTS bond_id TEXT;
ALTER TABLE bond_market_observations ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE bond_market_observations ADD COLUMN IF NOT EXISTS source_record_id TEXT;
ALTER TABLE bond_market_observations ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'SOURCE_RECORDED';
ALTER TABLE bond_market_observations ADD COLUMN IF NOT EXISTS checksum TEXT;
CREATE INDEX IF NOT EXISTS bond_market_observations_bond_date_idx ON bond_market_observations(bond_id, observation_date);

DO $$ BEGIN
  ALTER TABLE bond_market_observations ADD CONSTRAINT bond_market_observations_bond_id_fkey FOREIGN KEY (bond_id) REFERENCES bond_instruments(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
