CREATE TABLE IF NOT EXISTS fund_source_allocation_observations (
 id uuid PRIMARY KEY, fund_id text NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
 share_class_id text REFERENCES fund_share_classes(id) ON DELETE SET NULL,
 domain text NOT NULL, raw_category text NOT NULL, canonical_category text,
 amount numeric(30,8), amount_unit text, percentage numeric(18,8) NOT NULL,
 as_of_date date NOT NULL, source text NOT NULL, provider_product_id text NOT NULL,
 artifact_id text NOT NULL, retrieved_at timestamptz NOT NULL, parser_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS fund_source_allocations_fund_idx ON fund_source_allocation_observations(fund_id,domain,as_of_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS fund_source_allocations_natural_uidx ON fund_source_allocation_observations(fund_id,COALESCE(share_class_id,''),domain,raw_category,as_of_date,source,provider_product_id);
