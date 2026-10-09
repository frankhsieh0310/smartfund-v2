CREATE TABLE IF NOT EXISTS insider_ownership_denominators (
  id uuid PRIMARY KEY, security_id text NOT NULL REFERENCES securities(id), share_class_id uuid REFERENCES security_share_classes(id),
  denominator_value numeric(30,6) NOT NULL, denominator_date date NOT NULL, valid_from date, valid_to date,
  denominator_type text NOT NULL, quality_state text NOT NULL, taxonomy_concept text,
  source text NOT NULL, source_record_id text NOT NULL, source_url text NOT NULL,
  retrieved_at timestamptz NOT NULL, checksum text, parser_name text NOT NULL, parser_version text NOT NULL,
  verification_status text NOT NULL, license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  UNIQUE(security_id,source,source_record_id,denominator_date)
);
CREATE INDEX IF NOT EXISTS insider_ownership_denominators_security_date_idx ON insider_ownership_denominators(security_id,denominator_date);

CREATE TABLE IF NOT EXISTS proxy_ownership_filings (
  id uuid PRIMARY KEY, security_id text NOT NULL REFERENCES securities(id), form_type text NOT NULL,
  filing_date date NOT NULL, ownership_as_of_date date, accession_number text NOT NULL,
  source text NOT NULL, source_url text NOT NULL, retrieved_at timestamptz NOT NULL,
  checksum text, parser_name text NOT NULL, parser_version text NOT NULL,
  verification_status text NOT NULL, quality_status text NOT NULL,
  license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL', UNIQUE(source,accession_number,security_id)
);

CREATE TABLE IF NOT EXISTS proxy_ownership_rows (
  id uuid PRIMARY KEY, proxy_filing_id uuid NOT NULL REFERENCES proxy_ownership_filings(id),
  security_id text NOT NULL REFERENCES securities(id), owner_id uuid REFERENCES insider_owners(id),
  owner_name_raw text NOT NULL, owner_mapping_status text NOT NULL, row_semantic text NOT NULL,
  share_class_text text, shares_held numeric(30,6), ownership_percent numeric(18,10),
  source_reported_percent boolean NOT NULL DEFAULT false, footnotes text,
  as_of_date date, source_record_id text NOT NULL, verification_status text NOT NULL,
  UNIQUE(proxy_filing_id,source_record_id)
);

ALTER TABLE beneficial_ownership_filings ADD COLUMN IF NOT EXISTS share_class_text text;
ALTER TABLE beneficial_ownership_filings ADD COLUMN IF NOT EXISTS sole_voting_power_shares numeric(30,6);
ALTER TABLE beneficial_ownership_filings ADD COLUMN IF NOT EXISTS shared_voting_power_shares numeric(30,6);
ALTER TABLE beneficial_ownership_filings ADD COLUMN IF NOT EXISTS sole_dispositive_power_shares numeric(30,6);
ALTER TABLE beneficial_ownership_filings ADD COLUMN IF NOT EXISTS shared_dispositive_power_shares numeric(30,6);
ALTER TABLE beneficial_ownership_filings ADD COLUMN IF NOT EXISTS group_semantics text;

ALTER TABLE insider_ownership_snapshots ADD COLUMN IF NOT EXISTS numerator_source text;
ALTER TABLE insider_ownership_snapshots ADD COLUMN IF NOT EXISTS denominator_id uuid REFERENCES insider_ownership_denominators(id);
ALTER TABLE insider_ownership_snapshots ADD COLUMN IF NOT EXISTS formula_version text;
ALTER TABLE insider_ownership_snapshots ADD COLUMN IF NOT EXISTS denominator_quality_state text;

ALTER TABLE insider_ownership_source_matrix ADD COLUMN IF NOT EXISTS disclosure_regime text;
ALTER TABLE insider_ownership_source_matrix ADD COLUMN IF NOT EXISTS owner_types jsonb;
ALTER TABLE insider_ownership_source_matrix ADD COLUMN IF NOT EXISTS threshold_text text;
ALTER TABLE insider_ownership_source_matrix ADD COLUMN IF NOT EXISTS share_count_availability text;
ALTER TABLE insider_ownership_source_matrix ADD COLUMN IF NOT EXISTS percent_availability text;
ALTER TABLE insider_ownership_source_matrix ADD COLUMN IF NOT EXISTS voting_power_availability text;
ALTER TABLE insider_ownership_source_matrix ADD COLUMN IF NOT EXISTS history_availability text;
ALTER TABLE insider_ownership_source_matrix ADD COLUMN IF NOT EXISTS amendment_semantics text;
ALTER TABLE insider_ownership_source_matrix ADD COLUMN IF NOT EXISTS adapter_state text;

ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS section16_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS beneficial_ownership_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS proxy_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS denominator_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS reported_percent_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS derived_percent_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS pit_level integer NOT NULL DEFAULT 0;
ALTER TABLE insider_ownership_issuer_coverage ADD COLUMN IF NOT EXISTS detail_readiness text NOT NULL DEFAULT 'NOT_READY';

ALTER TABLE insider_ownership_owner_coverage ADD COLUMN IF NOT EXISTS ownership_domains jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE insider_ownership_owner_coverage ADD COLUMN IF NOT EXISTS ambiguity_status text NOT NULL DEFAULT 'UNRESOLVED';
