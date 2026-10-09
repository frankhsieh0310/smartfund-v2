-- GLOBAL_INSIDER_OWNERSHIP state/snapshot domain. Existing insider_ownership_transactions remains transaction truth.
CREATE TABLE IF NOT EXISTS insider_owners (
  id uuid PRIMARY KEY, owner_type text NOT NULL, legal_name text NOT NULL,
  regulator_owner_id text, cik text, country text, jurisdiction text, status text NOT NULL,
  source text NOT NULL, source_key text NOT NULL UNIQUE, source_type text NOT NULL DEFAULT 'REGULATOR_OFFICIAL',
  source_record_id text, source_url text, retrieved_at timestamptz NOT NULL,
  verification_status text NOT NULL, license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS insider_owners_source_regulator_idx ON insider_owners(source,regulator_owner_id) WHERE regulator_owner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS insider_owner_aliases (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES insider_owners(id) ON DELETE CASCADE,
  alias_name text NOT NULL, source text NOT NULL, source_record_id text, source_url text,
  effective_from date, effective_to date, retrieved_at timestamptz NOT NULL,
  verification_status text NOT NULL, license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  UNIQUE(owner_id,alias_name,source)
);

CREATE TABLE IF NOT EXISTS insider_issuer_relationships (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES insider_owners(id), security_id text NOT NULL REFERENCES securities(id),
  is_director boolean NOT NULL DEFAULT false, is_officer boolean NOT NULL DEFAULT false,
  is_ten_percent_owner boolean NOT NULL DEFAULT false, is_other boolean NOT NULL DEFAULT false,
  normalized_role text NOT NULL DEFAULT 'UNKNOWN', raw_role_text text,
  officer_title text, relationship_start date, relationship_end date,
  source text NOT NULL, filing_id text, source_record_id text, source_url text,
  retrieved_at timestamptz NOT NULL, verification_status text NOT NULL,
  license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  UNIQUE(owner_id,security_id,source,filing_id)
);

CREATE TABLE IF NOT EXISTS security_share_classes (
  id uuid PRIMARY KEY, security_id text NOT NULL REFERENCES securities(id), class_name text NOT NULL,
  class_code text, voting_rights_per_share numeric(30,10), shares_outstanding numeric(30,6),
  shares_outstanding_date date, denominator_value numeric(30,6), denominator_date date,
  denominator_type text, source text NOT NULL, source_record_id text, source_url text,
  retrieved_at timestamptz NOT NULL, verification_status text NOT NULL,
  license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  UNIQUE(security_id,class_name,source,shares_outstanding_date)
);

CREATE TABLE IF NOT EXISTS beneficial_ownership_filings (
  id uuid PRIMARY KEY, security_id text NOT NULL REFERENCES securities(id), owner_id uuid NOT NULL REFERENCES insider_owners(id),
  form_type text NOT NULL, disclosure_regime text NOT NULL, filing_date date NOT NULL, event_date date,
  shares_beneficially_owned numeric(30,6), ownership_percent numeric(18,10), voting_power_percent numeric(18,10),
  source text NOT NULL, accession_number text, source_record_id text, source_url text NOT NULL,
  is_amendment boolean NOT NULL DEFAULT false, amends_filing_id uuid REFERENCES beneficial_ownership_filings(id),
  version_sequence integer NOT NULL DEFAULT 1, effective_version boolean NOT NULL DEFAULT true,
  superseded_at timestamptz, source_type text NOT NULL DEFAULT 'REGULATOR_OFFICIAL', retrieved_at timestamptz NOT NULL,
  verification_status text NOT NULL, license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  checksum text, parser_name text NOT NULL, parser_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source,accession_number,owner_id,security_id)
);

CREATE TABLE IF NOT EXISTS insider_ownership_snapshots (
  id uuid PRIMARY KEY, security_id text NOT NULL REFERENCES securities(id), owner_id uuid NOT NULL REFERENCES insider_owners(id),
  share_class_id uuid REFERENCES security_share_classes(id), filing_id uuid REFERENCES beneficial_ownership_filings(id),
  snapshot_type text NOT NULL, disclosure_regime text NOT NULL, as_of_date date NOT NULL, filing_date date,
  effective_from date, effective_to date, validity_interval_method text,
  shares_held numeric(30,6), ownership_percent numeric(18,10), ownership_percent_method text,
  voting_power_percent numeric(18,10), direct_indirect text NOT NULL,
  beneficial_ownership_type text NOT NULL, nature_of_ownership text, raw_source_text text,
  source text NOT NULL, source_type text NOT NULL DEFAULT 'REGULATOR_OFFICIAL', source_record_id text, source_url text,
  retrieved_at timestamptz NOT NULL, verification_status text NOT NULL, quality_status text NOT NULL,
  license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL', checksum text,
  parser_name text NOT NULL, parser_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(security_id,owner_id,share_class_id,as_of_date,snapshot_type,source,source_record_id)
);
CREATE INDEX IF NOT EXISTS insider_ownership_snapshots_security_date_idx ON insider_ownership_snapshots(security_id,as_of_date);

CREATE TABLE IF NOT EXISTS insider_ownership_changes (
  id uuid PRIMARY KEY, security_id text NOT NULL REFERENCES securities(id), owner_id uuid NOT NULL REFERENCES insider_owners(id),
  share_class_id uuid REFERENCES security_share_classes(id), from_snapshot_id uuid REFERENCES insider_ownership_snapshots(id),
  to_snapshot_id uuid NOT NULL REFERENCES insider_ownership_snapshots(id), previous_shares numeric(30,6), current_shares numeric(30,6),
  share_change numeric(30,6), previous_percent numeric(18,10), current_percent numeric(18,10), percent_change numeric(18,10),
  previous_voting_power numeric(18,10), current_voting_power numeric(18,10), voting_power_change numeric(18,10),
  change_type text NOT NULL, transaction_ids jsonb, source text NOT NULL, source_record_id text,
  source_url text, as_of_date date NOT NULL, retrieved_at timestamptz NOT NULL,
  verification_status text NOT NULL, license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  UNIQUE(to_snapshot_id)
);

CREATE TABLE IF NOT EXISTS insider_ownership_eligible_issuers (
  security_id text PRIMARY KEY REFERENCES securities(id), cik text, ticker text NOT NULL, market text,
  jurisdiction text NOT NULL, source_status text NOT NULL, eligibility_status text NOT NULL,
  no_ownership_event_found_verified boolean NOT NULL DEFAULT false, source_constrained boolean NOT NULL DEFAULT false,
  license_constrained boolean NOT NULL DEFAULT false, deterministic_rank integer NOT NULL,
  source text NOT NULL, checked_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS insider_ownership_source_matrix (
  jurisdiction text PRIMARY KEY, source_status text NOT NULL, official_sources jsonb NOT NULL,
  disclosure_semantics text NOT NULL, comparable_disclosure boolean,
  license_status text NOT NULL, verification_status text NOT NULL, checked_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS insider_ownership_source_cursors (
  source_scope text PRIMARY KEY, last_accession text, last_filing_timestamp timestamptz,
  last_source_cursor text, status text NOT NULL, updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS insider_ownership_issuer_coverage (
  security_id text PRIMARY KEY REFERENCES securities(id), source_status text NOT NULL,
  owner_count integer NOT NULL DEFAULT 0, role_covered_owner_count integer NOT NULL DEFAULT 0,
  snapshot_count integer NOT NULL DEFAULT 0, latest_as_of_date date,
  shares_coverage text NOT NULL, ownership_percent_coverage text NOT NULL, voting_power_coverage text NOT NULL,
  direct_indirect_coverage text NOT NULL, share_class_coverage text NOT NULL, historical_status text NOT NULL,
  change_status text NOT NULL, management_aggregate_status text NOT NULL, board_aggregate_status text NOT NULL,
  major_owner_status text NOT NULL, provenance_status text NOT NULL, freshness_status text NOT NULL,
  license_status text NOT NULL, coverage_status text NOT NULL, checked_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS insider_ownership_owner_coverage (
  owner_id uuid PRIMARY KEY REFERENCES insider_owners(id), identity_status text NOT NULL,
  issuer_count integer NOT NULL DEFAULT 0, role_status text NOT NULL, snapshot_count integer NOT NULL DEFAULT 0,
  first_seen_date date, latest_seen_date date, shares_status text NOT NULL,
  ownership_percent_status text NOT NULL, voting_power_status text NOT NULL,
  provenance_status text NOT NULL, checked_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS insider_ownership_aggregates (
  id uuid PRIMARY KEY, security_id text NOT NULL REFERENCES securities(id), as_of_date date NOT NULL,
  aggregate_type text NOT NULL, owner_count integer NOT NULL, aggregate_shares numeric(30,6),
  aggregate_ownership_percent numeric(18,10), aggregate_voting_power_percent numeric(18,10),
  covered_ownership_percent numeric(18,10), calculation_status text NOT NULL,
  source text NOT NULL, source_record_id text, retrieved_at timestamptz NOT NULL,
  verification_status text NOT NULL, license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  UNIQUE(security_id,as_of_date,aggregate_type)
);
