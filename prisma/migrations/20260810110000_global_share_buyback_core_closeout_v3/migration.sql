ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS authorization_state text NOT NULL DEFAULT 'SOURCE_CONSTRAINED';
ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS program_state text NOT NULL DEFAULT 'NO_VERIFIED_PROGRAM';
ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS execution_state text NOT NULL DEFAULT 'NO_VERIFIED_EXECUTION';
ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS program_link_state text NOT NULL DEFAULT 'NO_PROGRAM_LINK';
ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS share_state text NOT NULL DEFAULT 'SOURCE_NOT_AVAILABLE';
ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'SOURCE_NOT_AVAILABLE';
ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS analytics_state text NOT NULL DEFAULT 'NOT_READY';
ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS provenance_state text NOT NULL DEFAULT 'PENDING';
ALTER TABLE share_buyback_issuer_coverage ADD COLUMN IF NOT EXISTS authorization_evidence jsonb;

CREATE TABLE IF NOT EXISTS share_buyback_authorization_reviews (
  security_id text PRIMARY KEY REFERENCES securities(id), cik text NOT NULL, issuer_ticker text NOT NULL,
  authorization_state text NOT NULL, program_identity_state text NOT NULL,
  authorization_tags jsonb NOT NULL, execution_share_tags jsonb NOT NULL,
  official_source_url text NOT NULL, source_type text NOT NULL DEFAULT 'REGULATOR_OFFICIAL',
  parser_version text NOT NULL, verification_status text NOT NULL,
  retrieved_at timestamptz NOT NULL, source_checksum text NOT NULL, source_payload jsonb NOT NULL
);
