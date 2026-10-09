CREATE TABLE IF NOT EXISTS moneydj_external_products (
 id uuid PRIMARY KEY,
 moneydj_code text NOT NULL UNIQUE,
 product_name text NOT NULL,
 product_scope text NOT NULL,
 source_route text NOT NULL,
 source_status text NOT NULL DEFAULT 'UNKNOWN',
 source_date date,
 currency text,
 inception_date date,
 management_fee numeric(18,8),
 custody_fee numeric(18,8),
 expense_ratio numeric(18,8),
 aum numeric(30,8),
 aum_currency text,
 rating numeric(18,8),
 canonical_fund_id text REFERENCES funds(id) ON DELETE SET NULL,
 canonical_share_class_id text REFERENCES fund_share_classes(id) ON DELETE SET NULL,
 mapping_status text NOT NULL,
 raw_payload jsonb NOT NULL,
 fingerprint text NOT NULL,
 retrieved_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS moneydj_external_products_mapping_idx ON moneydj_external_products(mapping_status,product_scope);

CREATE TABLE IF NOT EXISTS moneydj_external_field_observations (
 id uuid PRIMARY KEY,
 external_product_id uuid NOT NULL REFERENCES moneydj_external_products(id) ON DELETE CASCADE,
 page_family text NOT NULL,
 field_code text NOT NULL,
 field_name text,
 raw_value text NOT NULL,
 as_of_date date,
 data_origin text NOT NULL DEFAULT 'SOURCE_REPORTED',
 parser_version text NOT NULL,
 retrieved_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(external_product_id,page_family,field_code,as_of_date,raw_value)
);
CREATE INDEX IF NOT EXISTS moneydj_external_fields_family_idx ON moneydj_external_field_observations(page_family,field_code,as_of_date DESC);
