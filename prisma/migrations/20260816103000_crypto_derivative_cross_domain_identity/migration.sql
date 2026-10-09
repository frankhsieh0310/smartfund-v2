ALTER TABLE crypto_markets ALTER COLUMN quote_asset_id DROP NOT NULL;

CREATE TABLE crypto_derivative_asset_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id text NOT NULL REFERENCES crypto_markets(id),
  role text NOT NULL CHECK (role IN ('UNDERLYING','QUOTE','SETTLEMENT','MARGIN','REFERENCE')),
  asset_domain text NOT NULL CHECK (asset_domain IN ('CRYPTO_ASSET','FIAT_CURRENCY')),
  crypto_asset_id text REFERENCES crypto_assets(id), fiat_currency_id text REFERENCES fx_currencies(code),
  effective_from timestamptz, effective_to timestamptz, source text NOT NULL, source_url text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crypto_derivative_asset_reference_target_check CHECK (
    (asset_domain='CRYPTO_ASSET' AND crypto_asset_id IS NOT NULL AND fiat_currency_id IS NULL) OR
    (asset_domain='FIAT_CURRENCY' AND fiat_currency_id IS NOT NULL AND crypto_asset_id IS NULL)),
  CONSTRAINT crypto_derivative_asset_reference_dates_check CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to>effective_from)
);
CREATE UNIQUE INDEX crypto_derivative_asset_reference_active_role_key ON crypto_derivative_asset_references(product_id,role) WHERE effective_to IS NULL;
CREATE INDEX crypto_derivative_asset_reference_target_idx ON crypto_derivative_asset_references(asset_domain,crypto_asset_id,fiat_currency_id);

CREATE TABLE crypto_provider_asset_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, exchange_id text NOT NULL REFERENCES crypto_exchanges(id),
  alias_type text NOT NULL DEFAULT 'SYMBOL_ALIAS' CHECK(alias_type='SYMBOL_ALIAS'), provider_symbol text NOT NULL,
  asset_domain text NOT NULL CHECK(asset_domain IN ('CRYPTO_ASSET','FIAT_CURRENCY')),
  crypto_asset_id text REFERENCES crypto_assets(id), fiat_currency_id text REFERENCES fx_currencies(code), canonical_symbol text NOT NULL,
  effective_from timestamptz, effective_to timestamptz, source text NOT NULL, source_url text NOT NULL, source_artifact jsonb,
  verification_status text NOT NULL CHECK(verification_status IN ('VERIFIED_OFFICIAL','PENDING','CONFLICT')),
  retrieved_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crypto_provider_alias_target_check CHECK (
    (asset_domain='CRYPTO_ASSET' AND crypto_asset_id IS NOT NULL AND fiat_currency_id IS NULL) OR
    (asset_domain='FIAT_CURRENCY' AND fiat_currency_id IS NOT NULL AND crypto_asset_id IS NULL)),
  CONSTRAINT crypto_provider_alias_dates_check CHECK(effective_to IS NULL OR effective_from IS NULL OR effective_to>effective_from)
);
CREATE UNIQUE INDEX crypto_provider_alias_active_key ON crypto_provider_asset_aliases(provider,exchange_id,provider_symbol,alias_type) WHERE effective_to IS NULL;
CREATE INDEX crypto_provider_alias_target_idx ON crypto_provider_asset_aliases(asset_domain,crypto_asset_id,fiat_currency_id);
