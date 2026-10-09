CREATE TABLE IF NOT EXISTS security_regulatory_evidence (
  id uuid PRIMARY KEY,
  security_id text REFERENCES securities(id) ON DELETE SET NULL,
  source text NOT NULL,
  accession text NOT NULL,
  source_record_id text NOT NULL,
  source_url text NOT NULL,
  raw_artifact_ref text NOT NULL,
  raw_checksum text NOT NULL,
  filing_date date,
  report_date date,
  security_name text NOT NULL,
  issuer_name text,
  lei text,
  isin text,
  cusip text,
  ticker text,
  asset_category text NOT NULL,
  issuer_category text,
  canonical_security_type text NOT NULL,
  currency text,
  country text,
  maturity_date date,
  coupon_rate numeric(18,8),
  coupon_type text,
  regulatory_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  retrieved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT security_regulatory_evidence_source_record_key UNIQUE(source, accession, source_record_id)
);

CREATE INDEX IF NOT EXISTS security_regulatory_evidence_security_idx
  ON security_regulatory_evidence(security_id);
CREATE INDEX IF NOT EXISTS security_regulatory_evidence_isin_idx
  ON security_regulatory_evidence(isin);
CREATE INDEX IF NOT EXISTS security_regulatory_evidence_cusip_idx
  ON security_regulatory_evidence(cusip);
CREATE INDEX IF NOT EXISTS security_regulatory_evidence_type_idx
  ON security_regulatory_evidence(canonical_security_type, report_date);
