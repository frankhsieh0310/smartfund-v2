CREATE TABLE IF NOT EXISTS institutional_institutions (
  id text PRIMARY KEY, legal_name text NOT NULL, display_name text NOT NULL,
  institution_type text NOT NULL, country text NOT NULL, jurisdiction text NOT NULL,
  regulator_id text, cik text, lei text, status text NOT NULL,
  inception_date date, termination_date date, source text NOT NULL,
  source_record_id text, source_url text, verification_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS institutional_institutions_cik_key ON institutional_institutions(cik) WHERE cik IS NOT NULL;

CREATE TABLE IF NOT EXISTS institution_name_history (
  id uuid PRIMARY KEY, institution_id text NOT NULL REFERENCES institutional_institutions(id),
  old_name text NOT NULL, new_name text NOT NULL, effective_date date,
  source text NOT NULL, verification_status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(institution_id, old_name, new_name)
);

CREATE TABLE IF NOT EXISTS institutional_filings (
  id uuid PRIMARY KEY, institution_id text NOT NULL REFERENCES institutional_institutions(id),
  filing_type text NOT NULL, disclosure_regime text NOT NULL,
  reporting_period_end date NOT NULL, filing_date date NOT NULL, accepted_at timestamptz,
  accession_number text NOT NULL UNIQUE, source_document_url text NOT NULL,
  is_amendment boolean NOT NULL DEFAULT false, amendment_type text,
  parent_filing_id uuid REFERENCES institutional_filings(id), amends_filing_id uuid REFERENCES institutional_filings(id),
  version_sequence integer NOT NULL DEFAULT 1, amendment_number integer,
  effective_version boolean NOT NULL DEFAULT true, superseded_at timestamptz,
  status text NOT NULL, source text NOT NULL, retrieved_at timestamptz NOT NULL,
  verification_status text NOT NULL, parser_name text NOT NULL, parser_version text NOT NULL,
  source_checksum text, information_table_url text,
  source_row_count integer, parsed_row_count integer, written_row_count integer,
  mapped_security_count integer, unmapped_security_count integer,
  reported_portfolio_value numeric(30,6), provenance_status text, quality_status text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institutional_filings_period_idx ON institutional_filings(institution_id, reporting_period_end);

CREATE TABLE IF NOT EXISTS institutional_portfolio_snapshots (
  id uuid PRIMARY KEY, institution_id text NOT NULL REFERENCES institutional_institutions(id),
  filing_id uuid NOT NULL UNIQUE REFERENCES institutional_filings(id), reporting_period_end date NOT NULL,
  position_count integer NOT NULL, reported_portfolio_value numeric(30,6) NOT NULL,
  source text NOT NULL, source_url text NOT NULL, retrieved_at timestamptz NOT NULL,
  verification_status text NOT NULL, quality_status text NOT NULL,
  freshness_status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE institutional_holdings ALTER COLUMN security_id DROP NOT NULL;
ALTER TABLE institutional_holdings ALTER COLUMN shares DROP NOT NULL;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS snapshot_id uuid REFERENCES institutional_portfolio_snapshots(id);
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS canonical_filing_id uuid REFERENCES institutional_filings(id);
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS issuer_name text;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS title_of_class text;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS cusip text;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS isin text;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS sedol text;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS figi text;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS principal_amount numeric(30,6);
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS share_or_principal_type text;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS put_call text;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS investment_discretion text;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS other_manager text;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS voting_authority_sole numeric(30,6);
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS voting_authority_shared numeric(30,6);
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS voting_authority_none numeric(30,6);
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS source_row_id text;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS portfolio_weight numeric(18,12);
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS verification_status text;
ALTER TABLE institutional_holdings ADD COLUMN IF NOT EXISTS quality_status text;
CREATE UNIQUE INDEX IF NOT EXISTS institutional_holdings_snapshot_row_key ON institutional_holdings(snapshot_id, source_row_id) WHERE snapshot_id IS NOT NULL;
-- The legacy global source_key uniqueness cannot represent immutable filing-version grain.
ALTER TABLE institutional_holdings DROP CONSTRAINT IF EXISTS institutional_holdings_source_key_key;
CREATE INDEX IF NOT EXISTS institutional_holdings_source_key_idx ON institutional_holdings(source_key);

CREATE TABLE IF NOT EXISTS institutional_security_mapping_queue (
  id uuid PRIMARY KEY, holding_id uuid REFERENCES institutional_holdings(id) ON DELETE CASCADE,
  cusip text, isin text, sedol text, figi text, issuer_name text NOT NULL, title_of_class text,
  status text NOT NULL, attempted_methods jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(holding_id)
);

CREATE TABLE IF NOT EXISTS institutional_holding_changes (
  id uuid PRIMARY KEY, institution_id text NOT NULL REFERENCES institutional_institutions(id),
  security_identity text NOT NULL, from_period date NOT NULL, to_period date NOT NULL,
  previous_shares numeric(30,6), current_shares numeric(30,6), share_change numeric(30,6), share_change_percent numeric(20,8),
  previous_value numeric(30,6), current_value numeric(30,6), value_change numeric(30,6),
  previous_weight numeric(18,12), current_weight numeric(18,12), weight_change numeric(18,12),
  change_type text NOT NULL, price_effect text NOT NULL DEFAULT 'UNKNOWN', calculation_version text NOT NULL,
  calculated_at timestamptz NOT NULL, UNIQUE(institution_id, security_identity, from_period, to_period)
);

CREATE TABLE IF NOT EXISTS institutional_portfolio_analytics (
  id uuid PRIMARY KEY, snapshot_id uuid NOT NULL REFERENCES institutional_portfolio_snapshots(id),
  metric text NOT NULL, value jsonb NOT NULL, calculation_formula text NOT NULL,
  version text NOT NULL, calculated_at timestamptz NOT NULL,
  UNIQUE(snapshot_id, metric, version)
);

CREATE TABLE IF NOT EXISTS institutional_ownership_disclosures (
  id uuid PRIMARY KEY, institution_id text NOT NULL REFERENCES institutional_institutions(id),
  filing_id uuid NOT NULL UNIQUE REFERENCES institutional_filings(id), security_id text,
  issuer_name text, ownership_percent numeric(20,8), shares_beneficially_owned numeric(30,6),
  filing_date date NOT NULL, event_date date, filing_type text NOT NULL,
  source text NOT NULL, verification_status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS institutional_coverage_matrix (
  institution_id text PRIMARY KEY REFERENCES institutional_institutions(id), identity_status text NOT NULL,
  filing_source_status text NOT NULL, latest_filing_date date, reporting_period_count integer NOT NULL DEFAULT 0,
  full_portfolio_status text NOT NULL, position_count integer NOT NULL DEFAULT 0,
  reported_portfolio_value numeric(30,6), security_mapping_rate numeric(10,6), amendment_status text NOT NULL,
  historical_status text NOT NULL, position_change_status text NOT NULL, allocation_status text NOT NULL,
  analytics_status text NOT NULL, provenance_status text NOT NULL, freshness_status text NOT NULL,
  coverage_status text NOT NULL, updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS institutional_source_archives (
  id uuid PRIMARY KEY, filing_id uuid REFERENCES institutional_filings(id), source_url text NOT NULL,
  checksum text NOT NULL, retrieved_at timestamptz NOT NULL, parser_name text NOT NULL,
  parser_version text NOT NULL, local_archive_path text, UNIQUE(source_url, checksum)
);
