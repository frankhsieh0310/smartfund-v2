CREATE TABLE IF NOT EXISTS security_product_links (
  id uuid PRIMARY KEY,
  security_id text NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  product_type text NOT NULL,
  product_id text NOT NULL,
  match_method text NOT NULL,
  verification_status text NOT NULL,
  source text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(security_id, product_type, product_id)
);
CREATE INDEX IF NOT EXISTS security_product_links_product_idx ON security_product_links(product_type,product_id);

CREATE TABLE IF NOT EXISTS fund_security_ownership (
  id uuid PRIMARY KEY,
  fund_id text NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  share_class_id text REFERENCES fund_share_classes(id) ON DELETE SET NULL,
  security_id text NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  as_of_date date NOT NULL,
  weight numeric(12,8),
  rank integer,
  source text NOT NULL,
  filing_id text,
  source_row_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(fund_id,share_class_id,security_id,as_of_date,source)
);
CREATE INDEX IF NOT EXISTS fund_security_ownership_security_idx ON fund_security_ownership(security_id,as_of_date DESC);
CREATE INDEX IF NOT EXISTS fund_security_ownership_fund_idx ON fund_security_ownership(fund_id,share_class_id,as_of_date DESC);
CREATE INDEX IF NOT EXISTS fund_security_ownership_current_idx ON fund_security_ownership(security_id,fund_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS fund_holding_snapshot_metrics (
  id uuid PRIMARY KEY,
  fund_id text NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  share_class_id text REFERENCES fund_share_classes(id) ON DELETE SET NULL,
  as_of_date date NOT NULL,
  source text NOT NULL,
  canonical_security_count integer NOT NULL,
  product_linked_count integer NOT NULL,
  security_only_count integer NOT NULL,
  top1_weight numeric(12,8),
  top5_weight numeric(12,8),
  top10_weight numeric(12,8),
  top20_weight numeric(12,8),
  hhi numeric(18,12),
  effective_holding_count numeric(18,8),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(fund_id,share_class_id,as_of_date,source)
);

CREATE TABLE IF NOT EXISTS fund_holding_changes (
  id uuid PRIMARY KEY,
  fund_id text NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  share_class_id text REFERENCES fund_share_classes(id) ON DELETE SET NULL,
  security_id text NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  previous_as_of date NOT NULL,
  current_as_of date NOT NULL,
  change_type text NOT NULL,
  previous_weight numeric(12,8),
  current_weight numeric(12,8),
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(fund_id,share_class_id,security_id,previous_as_of,current_as_of,source)
);
CREATE INDEX IF NOT EXISTS fund_holding_changes_security_idx ON fund_holding_changes(security_id,current_as_of DESC);

CREATE OR REPLACE VIEW fund_security_ownership_current AS
SELECT * FROM fund_security_ownership WHERE is_current;
