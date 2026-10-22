CREATE TABLE IF NOT EXISTS moneydj_product_route_dispositions (
 id uuid PRIMARY KEY,
 external_product_id uuid NOT NULL REFERENCES moneydj_external_products(id) ON DELETE CASCADE,
 route_family text NOT NULL,
 source_url text NOT NULL,
 state text NOT NULL,
 artifact_path text,
 fingerprint text,
 discovered_routes jsonb NOT NULL DEFAULT '[]'::jsonb,
 iframe_count integer NOT NULL DEFAULT 0,
 xhr_count integer NOT NULL DEFAULT 0,
 field_count integer NOT NULL DEFAULT 0,
 attempts integer NOT NULL DEFAULT 0,
 last_error text,
 retrieved_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(external_product_id,route_family)
);
CREATE INDEX IF NOT EXISTS moneydj_route_dispositions_state_idx ON moneydj_product_route_dispositions(route_family,state,updated_at);

CREATE TABLE IF NOT EXISTS moneydj_product_history_dispositions (
 id uuid PRIMARY KEY,
 external_product_id uuid NOT NULL REFERENCES moneydj_external_products(id) ON DELETE CASCADE,
 domain text NOT NULL,
 state text NOT NULL,
 source_url text,
 checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
 attempts integer NOT NULL DEFAULT 0,
 last_error text,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 completed_at timestamptz,
 UNIQUE(external_product_id,domain)
);
CREATE INDEX IF NOT EXISTS moneydj_history_dispositions_state_idx ON moneydj_product_history_dispositions(domain,state,updated_at);
