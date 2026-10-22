CREATE TABLE IF NOT EXISTS shared_asset_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_type text NOT NULL,
  canonical_key text NOT NULL,
  canonical_name text NOT NULL,
  short_name text,
  official_name text,
  source text NOT NULL,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(asset_type, canonical_key)
);
CREATE TABLE IF NOT EXISTS shared_asset_identity_localizations (
  identity_id uuid NOT NULL REFERENCES shared_asset_identities(id) ON DELETE CASCADE,
  language text NOT NULL,
  locale text NOT NULL,
  localized_name text NOT NULL,
  local_name text,
  official_name text,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text NOT NULL,
  source_url text,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(identity_id, locale)
);
CREATE INDEX IF NOT EXISTS shared_asset_identity_localizations_name_idx ON shared_asset_identity_localizations(localized_name);
CREATE TABLE IF NOT EXISTS taifex_official_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL,
  source_record_id text NOT NULL,
  observed_at date,
  canonical_key text,
  payload jsonb NOT NULL,
  source_url text NOT NULL,
  verification_status text NOT NULL DEFAULT 'VERIFIED_OFFICIAL',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(domain, source_record_id)
);
