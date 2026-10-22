ALTER TABLE futures_product_roots ALTER COLUMN commodity_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS equity_index_futures_coverage (
  root_id TEXT PRIMARY KEY,
  identity_status TEXT NOT NULL,
  source_state TEXT NOT NULL,
  listed_contract_count INTEGER NOT NULL DEFAULT 0,
  current_official_status TEXT NOT NULL,
  history_status TEXT NOT NULL,
  settlement_status TEXT NOT NULL,
  volume_status TEXT NOT NULL,
  open_interest_status TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  continuous_series_status TEXT NOT NULL,
  analytics_status TEXT NOT NULL,
  provenance_status TEXT NOT NULL,
  freshness_status TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE futures_observations ADD COLUMN IF NOT EXISTS retrieved_at TIMESTAMPTZ;
ALTER TABLE futures_observations ADD COLUMN IF NOT EXISTS parser_version TEXT;
ALTER TABLE futures_observations ADD COLUMN IF NOT EXISTS source_checksum TEXT;
ALTER TABLE futures_observations ADD COLUMN IF NOT EXISTS license_status TEXT NOT NULL DEFAULT 'SOURCE_PENDING';

CREATE INDEX IF NOT EXISTS equity_index_futures_contract_scope_idx
  ON futures_contracts(asset_class, exchange, root_symbol, contract_month);

