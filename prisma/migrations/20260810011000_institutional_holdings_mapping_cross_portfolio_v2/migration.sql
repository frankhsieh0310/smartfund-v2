ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS raw_identifier text;
ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS normalized_identifier text;
ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS normalization_method text;
ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS validation_status text;
ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS security_id text;
ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS mapping_method text;
ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS source_identifier text;
ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS canonical_identifier text;
ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS verification_source text;
ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS mapping_version text;
ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS failure_reason text;
ALTER TABLE institutional_security_mapping_queue ADD COLUMN IF NOT EXISTS asset_type text;

ALTER TABLE institutional_ownership_disclosures ADD COLUMN IF NOT EXISTS security_class text;
ALTER TABLE institutional_ownership_disclosures ADD COLUMN IF NOT EXISTS cusip text;
ALTER TABLE institutional_ownership_disclosures ADD COLUMN IF NOT EXISTS sole_voting_power numeric(30,6);
ALTER TABLE institutional_ownership_disclosures ADD COLUMN IF NOT EXISTS shared_voting_power numeric(30,6);
ALTER TABLE institutional_ownership_disclosures ADD COLUMN IF NOT EXISTS sole_dispositive_power numeric(30,6);
ALTER TABLE institutional_ownership_disclosures ADD COLUMN IF NOT EXISTS shared_dispositive_power numeric(30,6);
ALTER TABLE institutional_ownership_disclosures ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE institutional_ownership_disclosures ADD COLUMN IF NOT EXISTS parser_version text;
ALTER TABLE institutional_ownership_disclosures ADD COLUMN IF NOT EXISTS quality_status text;

CREATE TABLE IF NOT EXISTS institutional_portfolio_overlap (
  id uuid PRIMARY KEY, reporting_period_end date NOT NULL,
  institution_a_id text NOT NULL REFERENCES institutional_institutions(id),
  institution_b_id text NOT NULL REFERENCES institutional_institutions(id),
  shared_security_count integer NOT NULL, overlap_weight numeric(18,12) NOT NULL,
  overlap_reported_value numeric(30,6) NOT NULL, top_shared_holdings jsonb NOT NULL,
  identity_policy text NOT NULL, calculation_version text NOT NULL,
  calculated_at timestamptz NOT NULL,
  UNIQUE(reporting_period_end,institution_a_id,institution_b_id,calculation_version)
);

CREATE TABLE IF NOT EXISTS institutional_security_crowding (
  id uuid PRIMARY KEY, reporting_period_end date NOT NULL,
  security_identity text NOT NULL, institution_count integer NOT NULL,
  aggregate_reported_value numeric(30,6) NOT NULL,
  aggregate_reported_shares numeric(30,6), aggregate_portfolio_weight numeric(18,12) NOT NULL,
  identity_policy text NOT NULL, minimum_institution_gate integer NOT NULL,
  calculation_version text NOT NULL, calculated_at timestamptz NOT NULL,
  UNIQUE(reporting_period_end,security_identity,calculation_version)
);

ALTER TABLE institutional_coverage_matrix ADD COLUMN IF NOT EXISTS holding_rows integer NOT NULL DEFAULT 0;
ALTER TABLE institutional_coverage_matrix ADD COLUMN IF NOT EXISTS overlap_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE institutional_coverage_matrix ADD COLUMN IF NOT EXISTS ownership_disclosure_status text NOT NULL DEFAULT 'PENDING';
ALTER TABLE institutional_coverage_matrix ADD COLUMN IF NOT EXISTS detail_readiness text NOT NULL DEFAULT 'NOT_READY';
