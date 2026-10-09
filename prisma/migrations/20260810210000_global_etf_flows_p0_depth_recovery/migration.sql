CREATE TABLE IF NOT EXISTS etf_issuers (
  id uuid PRIMARY KEY, code text NOT NULL UNIQUE, official_name text NOT NULL,
  official_url text NOT NULL, source_status text NOT NULL,
  verification_status text NOT NULL, license_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS etf_issuer_mappings (
  etf_id text PRIMARY KEY REFERENCES etfs(id), issuer_id uuid NOT NULL REFERENCES etf_issuers(id),
  source text NOT NULL, verification_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS etf_issuer_mappings_issuer_id_idx ON etf_issuer_mappings(issuer_id);

CREATE TABLE IF NOT EXISTS etf_shares_outstanding (
  id uuid PRIMARY KEY, etf_id text NOT NULL REFERENCES etfs(id), observation_date date NOT NULL,
  shares_outstanding numeric(30,6) NOT NULL, source text NOT NULL, source_record_id text,
  source_url text, publication_date date, retrieved_at timestamptz NOT NULL,
  verification_status text NOT NULL, quality_status text NOT NULL, license_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(etf_id,observation_date,source)
);
CREATE INDEX IF NOT EXISTS etf_shares_outstanding_etf_date_idx ON etf_shares_outstanding(etf_id,observation_date);

CREATE TABLE IF NOT EXISTS etf_creation_redemptions (
  id uuid PRIMARY KEY, etf_id text NOT NULL REFERENCES etfs(id), observation_date date NOT NULL,
  created_shares numeric(30,6), created_units numeric(30,6), creation_value numeric(30,6),
  redeemed_shares numeric(30,6), redeemed_units numeric(30,6), redemption_value numeric(30,6), currency text,
  source text NOT NULL, source_record_id text, source_url text, retrieved_at timestamptz NOT NULL,
  verification_status text NOT NULL, license_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(etf_id,observation_date,source)
);

ALTER TABLE etf_asset_metrics ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE etf_asset_metrics ADD COLUMN IF NOT EXISTS retrieved_at timestamptz;
ALTER TABLE etf_asset_metrics ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'UNVERIFIED_LEGACY';
ALTER TABLE etf_asset_metrics ADD COLUMN IF NOT EXISTS quality_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE etf_asset_metrics ADD COLUMN IF NOT EXISTS license_status text NOT NULL DEFAULT 'TERMS_REVIEW_REQUIRED';

ALTER TABLE etf_flows ADD COLUMN IF NOT EXISTS current_shares numeric(30,6);
ALTER TABLE etf_flows ADD COLUMN IF NOT EXISTS prior_shares numeric(30,6);
ALTER TABLE etf_flows ADD COLUMN IF NOT EXISTS nav_used numeric(30,10);
ALTER TABLE etf_flows ADD COLUMN IF NOT EXISTS nav_date date;
ALTER TABLE etf_flows ADD COLUMN IF NOT EXISTS aum numeric(30,6);
ALTER TABLE etf_flows ADD COLUMN IF NOT EXISTS source_record_id text;
ALTER TABLE etf_flows ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'ISSUER_OFFICIAL';
ALTER TABLE etf_flows ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'UNVERIFIED_LEGACY';
ALTER TABLE etf_flows ADD COLUMN IF NOT EXISTS quality_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE etf_flows ADD COLUMN IF NOT EXISTS freshness_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE etf_flows ADD COLUMN IF NOT EXISTS license_status text NOT NULL DEFAULT 'TERMS_REVIEW_REQUIRED';
ALTER TABLE etf_flows ADD COLUMN IF NOT EXISTS retrieved_at timestamptz;
DROP INDEX IF EXISTS etf_flows_etf_date_method_key;
CREATE UNIQUE INDEX IF NOT EXISTS etf_flows_etf_date_method_source_key ON etf_flows(etf_id,observation_date,flow_method,source);

CREATE TABLE IF NOT EXISTS etf_flow_aggregates (
  id uuid PRIMARY KEY, etf_id text NOT NULL REFERENCES etfs(id), as_of_date date NOT NULL,
  window_name text NOT NULL, flow_value numeric(30,6) NOT NULL, currency text NOT NULL,
  flow_percent_aum numeric(18,10), aum_as_of_date date, calculation_method text NOT NULL,
  verification_status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(etf_id,as_of_date,window_name,currency)
);

CREATE TABLE IF NOT EXISTS etf_flow_coverage (
  etf_id text PRIMARY KEY REFERENCES etfs(id), issuer_id uuid REFERENCES etf_issuers(id),
  source_status text NOT NULL, shares_status text NOT NULL, shares_history_status text NOT NULL,
  nav_status text NOT NULL, aum_status text NOT NULL, daily_flow_status text NOT NULL,
  flow_method text, history_count integer NOT NULL DEFAULT 0, first_flow_date date, latest_flow_date date,
  weekly_status text NOT NULL, monthly_status text NOT NULL, ytd_status text NOT NULL,
  normalized_flow_status text NOT NULL, provenance_status text NOT NULL, freshness_status text NOT NULL,
  license_status text NOT NULL, coverage_status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS etf_flow_coverage_issuer_status_idx ON etf_flow_coverage(issuer_id,coverage_status);
