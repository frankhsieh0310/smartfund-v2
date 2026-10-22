CREATE TABLE IF NOT EXISTS economic_calendar_jurisdictions (
  jurisdiction_code text PRIMARY KEY,
  country_code_iso2 text,
  country_code_iso3 text,
  display_name text NOT NULL,
  region text NOT NULL,
  jurisdiction_type text NOT NULL CHECK (jurisdiction_type IN ('COUNTRY','MONETARY_UNION','REGION','AGGREGATE','OTHER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS economic_calendar_providers (
  provider_id text PRIMARY KEY,
  official_name text NOT NULL,
  provider_type text NOT NULL,
  jurisdiction_code text REFERENCES economic_calendar_jurisdictions(jurisdiction_code),
  official_website text NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('VERIFIED_OFFICIAL','PENDING','UNVERIFIED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS economic_calendar_series_classification (
  series_id text PRIMARY KEY REFERENCES economic_series(id) ON DELETE CASCADE,
  calendar_eligibility text NOT NULL CHECK (calendar_eligibility IN ('CALENDAR_RELEASE','MARKET_RATE','YIELD','SPREAD','LIQUIDITY','INVENTORY','CONTINUOUS_STATISTICAL_SERIES','OTHER','AMBIGUOUS')),
  classification_rule text NOT NULL,
  jurisdiction_code text REFERENCES economic_calendar_jurisdictions(jurisdiction_code),
  provider_id text REFERENCES economic_calendar_providers(provider_id),
  importance_method text NOT NULL CHECK (importance_method IN ('SOURCE_PROVIDED','EDITORIAL_RULE','LEGACY','UNKNOWN')),
  classified_at timestamptz NOT NULL DEFAULT now(),
  verification_status text NOT NULL DEFAULT 'DETERMINISTIC_RULE'
);

CREATE TABLE IF NOT EXISTS economic_release_events (
  event_id text PRIMARY KEY,
  series_id text NOT NULL REFERENCES economic_series(id) ON DELETE CASCADE,
  provider_id text NOT NULL REFERENCES economic_calendar_providers(provider_id),
  jurisdiction_code text REFERENCES economic_calendar_jurisdictions(jurisdiction_code),
  event_name text NOT NULL,
  reference_period_start date,
  reference_period_end date,
  reference_period_label text,
  official_release_date date,
  official_release_time time,
  official_release_timezone text,
  official_release_datetime_utc timestamptz,
  release_status text NOT NULL CHECK (release_status IN ('SCHEDULED_CONFIRMED','SCHEDULED_ESTIMATED','RELEASED','REVISED','POSTPONED','CANCELLED','SOURCE_PENDING','UNKNOWN')),
  importance text,
  importance_method text NOT NULL DEFAULT 'UNKNOWN',
  actual_value numeric,
  previous_value numeric,
  forecast_value numeric,
  revised_value numeric,
  unit text,
  source text NOT NULL,
  source_type text NOT NULL,
  source_record_id text,
  source_url text,
  retrieved_at timestamptz NOT NULL,
  as_of_timestamp timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL,
  verification_status text NOT NULL,
  quality_status text NOT NULL,
  license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  surprise_absolute numeric,
  surprise_percent numeric,
  surprise_bps numeric,
  freshness_status text NOT NULL DEFAULT 'SOURCE_PENDING',
  UNIQUE(provider_id, source_record_id)
);

CREATE INDEX IF NOT EXISTS economic_release_events_series_release_idx ON economic_release_events(series_id, official_release_date);
CREATE INDEX IF NOT EXISTS economic_release_events_upcoming_idx ON economic_release_events(official_release_date, release_status);

CREATE TABLE IF NOT EXISTS economic_release_event_state_history (
  state_id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES economic_release_events(event_id) ON DELETE CASCADE,
  release_status text NOT NULL,
  observed_at timestamptz NOT NULL,
  source_url text,
  verification_status text NOT NULL,
  UNIQUE(event_id, release_status, observed_at)
);

CREATE TABLE IF NOT EXISTS economic_release_revisions (
  revision_id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES economic_release_events(event_id) ON DELETE CASCADE,
  series_id text NOT NULL REFERENCES economic_series(id) ON DELETE CASCADE,
  reference_date date NOT NULL,
  original_value numeric,
  previous_published_value numeric,
  revised_value numeric NOT NULL,
  revision_published_at timestamptz NOT NULL,
  source text NOT NULL,
  source_record_id text,
  source_url text,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  as_of_timestamp timestamptz NOT NULL,
  verification_status text NOT NULL,
  license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL'
);

CREATE TABLE IF NOT EXISTS economic_value_vintages (
  vintage_id text PRIMARY KEY,
  series_id text NOT NULL REFERENCES economic_series(id) ON DELETE CASCADE,
  reference_date date NOT NULL,
  vintage_datetime timestamptz NOT NULL,
  value numeric NOT NULL,
  release_event_id text REFERENCES economic_release_events(event_id),
  source text NOT NULL,
  source_record_id text,
  source_url text,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  as_of_timestamp timestamptz NOT NULL,
  verification_status text NOT NULL,
  license_status text NOT NULL DEFAULT 'UNKNOWN',
  UNIQUE(series_id, reference_date, vintage_datetime, source)
);

CREATE TABLE IF NOT EXISTS economic_calendar_forecast_audit (
  series_id text PRIMARY KEY REFERENCES economic_series(id) ON DELETE CASCADE,
  forecast_rows integer NOT NULL,
  forecast_type text NOT NULL CHECK (forecast_type IN ('OFFICIAL_FORECAST','CONSENSUS_FORECAST','MODEL_FORECAST','LEGACY_UNVERIFIED','UNKNOWN')),
  license_status text NOT NULL,
  source_evidence text,
  audited_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS economic_calendar_checkpoints (
  provider_id text NOT NULL REFERENCES economic_calendar_providers(provider_id),
  series_id text NOT NULL REFERENCES economic_series(id),
  last_scheduled_release_checked timestamptz,
  last_historical_release_processed date,
  last_successful_run timestamptz,
  next_eligible_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0,
  last_error text,
  PRIMARY KEY(provider_id, series_id)
);

CREATE TABLE IF NOT EXISTS economic_calendar_coverage (
  series_id text PRIMARY KEY REFERENCES economic_series(id) ON DELETE CASCADE,
  jurisdiction_code text,
  provider_id text,
  event_source_status text NOT NULL,
  upcoming_status text NOT NULL,
  historical_event_count integer NOT NULL DEFAULT 0,
  first_release_date date,
  latest_release_date date,
  official_time_coverage numeric NOT NULL DEFAULT 0,
  timezone_coverage numeric NOT NULL DEFAULT 0,
  actual_coverage numeric NOT NULL DEFAULT 0,
  previous_coverage numeric NOT NULL DEFAULT 0,
  forecast_coverage numeric NOT NULL DEFAULT 0,
  revision_coverage numeric NOT NULL DEFAULT 0,
  provenance_status text NOT NULL,
  freshness_status text NOT NULL,
  license_status text NOT NULL,
  coverage_status text NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS economic_values_series_date_key ON economic_values(series_id, date);
