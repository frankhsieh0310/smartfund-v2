-- PACKAGE ONLY: do not deploy until production migration approval.
CREATE TABLE IF NOT EXISTS etf_holding_snapshots (
  id uuid PRIMARY KEY,
  etf_id text NOT NULL REFERENCES etfs(id),
  effective_date date NOT NULL,
  report_date date,
  publication_date timestamptz,
  issuer_id text,
  source text NOT NULL,
  source_type text NOT NULL,
  source_url text NOT NULL,
  source_record_id text,
  retrieved_at timestamptz NOT NULL,
  checksum text NOT NULL,
  source_row_count integer NOT NULL,
  parsed_row_count integer NOT NULL,
  canonical_row_count integer NOT NULL,
  verification_status text NOT NULL,
  license_status text NOT NULL,
  completeness_status text NOT NULL,
  quality_status text NOT NULL,
  quality_metrics jsonb,
  parser_version text NOT NULL,
  archive_lineage jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(etf_id,effective_date,source_url,checksum)
);
CREATE INDEX IF NOT EXISTS etf_holding_snapshots_etf_date_idx ON etf_holding_snapshots(etf_id,effective_date);

CREATE TABLE IF NOT EXISTS etf_holdings (
  id uuid PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES etf_holding_snapshots(id) ON DELETE CASCADE,
  etf_id text NOT NULL,
  effective_date date NOT NULL,
  holding_type text NOT NULL,
  security_id text,
  holding_name text NOT NULL,
  ticker text, isin text, cusip text, sedol text, figi text,
  quantity numeric(38,10), price numeric(38,10), market_value numeric(38,8), weight numeric(14,8),
  currency text, country text, sector text, industry text, asset_class text,
  coupon numeric(14,8), maturity_date date, credit_rating text, notional numeric(38,8),
  source_row_id text NOT NULL,
  verification_status text NOT NULL,
  quality_status text NOT NULL,
  raw_row jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(snapshot_id,source_row_id)
);
CREATE INDEX IF NOT EXISTS etf_holdings_etf_date_idx ON etf_holdings(etf_id,effective_date);
CREATE INDEX IF NOT EXISTS etf_holdings_security_idx ON etf_holdings(security_id);
CREATE INDEX IF NOT EXISTS etf_holdings_isin_idx ON etf_holdings(isin);
CREATE INDEX IF NOT EXISTS etf_holdings_cusip_idx ON etf_holdings(cusip);
CREATE INDEX IF NOT EXISTS etf_holdings_sedol_idx ON etf_holdings(sedol);

CREATE TABLE IF NOT EXISTS etf_holding_derived (
  id uuid PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES etf_holding_snapshots(id) ON DELETE CASCADE,
  dataset text NOT NULL,
  method_version text NOT NULL,
  inputs jsonb NOT NULL,
  formula jsonb NOT NULL,
  output jsonb NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(snapshot_id,dataset,method_version)
);
