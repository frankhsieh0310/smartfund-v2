CREATE TABLE IF NOT EXISTS money_supply_authorities (
  id uuid PRIMARY KEY, code text NOT NULL UNIQUE, jurisdiction text NOT NULL,
  country text NOT NULL, currency text NOT NULL, official_name text NOT NULL,
  official_source_url text NOT NULL, machine_readable_source_url text,
  source_status text NOT NULL, verification_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS money_supply_series (
  id uuid PRIMARY KEY, canonical_series_id text NOT NULL UNIQUE,
  authority_id uuid NOT NULL REFERENCES money_supply_authorities(id),
  official_series_code text NOT NULL, external_series_id text NOT NULL,
  official_name text NOT NULL, aggregate_type text NOT NULL,
  comparability_family text NOT NULL, official_definition text NOT NULL,
  definition_source text NOT NULL, methodology_url text,
  definition_version text, frequency text NOT NULL, unit text NOT NULL,
  seasonal_adjustment text NOT NULL, provider text NOT NULL,
  official_url text NOT NULL, status text NOT NULL,
  start_date date, end_date date, verification_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(authority_id, official_series_code, seasonal_adjustment)
);
CREATE INDEX IF NOT EXISTS money_supply_series_authority_idx ON money_supply_series(authority_id);

CREATE TABLE IF NOT EXISTS money_supply_observations (
  id uuid PRIMARY KEY, series_id uuid NOT NULL REFERENCES money_supply_series(id),
  observation_date date NOT NULL, reference_period text,
  publication_date date, retrieved_at timestamptz NOT NULL,
  value numeric(30,10) NOT NULL, unit text NOT NULL, source text NOT NULL,
  source_url text NOT NULL, source_record_id text,
  source_version text NOT NULL, checksum text NOT NULL,
  verification_status text NOT NULL, is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(series_id, observation_date, source_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS money_supply_observations_current_grain_key
  ON money_supply_observations(series_id, observation_date) WHERE is_current;
CREATE INDEX IF NOT EXISTS money_supply_observations_series_date_idx
  ON money_supply_observations(series_id, observation_date);

CREATE TABLE IF NOT EXISTS money_supply_analytics (
  id uuid PRIMARY KEY, series_id uuid NOT NULL REFERENCES money_supply_series(id),
  observation_date date NOT NULL, metric text NOT NULL, value numeric(30,10) NOT NULL,
  formula_version text NOT NULL, verification_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(series_id, observation_date, metric, formula_version)
);
CREATE INDEX IF NOT EXISTS money_supply_analytics_series_metric_date_idx
  ON money_supply_analytics(series_id, metric, observation_date);
