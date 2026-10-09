ALTER TABLE economic_release_events DROP CONSTRAINT IF EXISTS economic_release_events_provider_id_source_record_id_key;
DROP INDEX IF EXISTS economic_release_events_provider_id_source_record_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS economic_release_events_provider_source_series_key ON economic_release_events(provider_id,source_record_id,series_id);

ALTER TABLE economic_release_events ADD COLUMN IF NOT EXISTS scheduled_release_datetime_utc timestamptz;
ALTER TABLE economic_release_events ADD COLUMN IF NOT EXISTS actual_release_datetime_utc timestamptz;
ALTER TABLE economic_release_events ADD COLUMN IF NOT EXISTS time_status text NOT NULL DEFAULT 'TIME_UNKNOWN';
ALTER TABLE economic_release_events ADD COLUMN IF NOT EXISTS parser_version text NOT NULL DEFAULT 'P0_V1';
ALTER TABLE economic_release_events ADD COLUMN IF NOT EXISTS raw_checksum text;
ALTER TABLE economic_release_events ADD COLUMN IF NOT EXISTS forecast_status text NOT NULL DEFAULT 'SOURCE_NOT_AVAILABLE';
ALTER TABLE economic_release_events ADD COLUMN IF NOT EXISTS surprise_status text NOT NULL DEFAULT 'NOT_AVAILABLE';

CREATE TABLE IF NOT EXISTS economic_calendar_agencies (
  agency_id text PRIMARY KEY REFERENCES economic_calendar_providers(provider_id),
  agency_name text NOT NULL,
  jurisdiction_code text REFERENCES economic_calendar_jurisdictions(jurisdiction_code),
  official_domain text NOT NULL,
  timezone text,
  calendar_url text NOT NULL,
  publication_authority text NOT NULL,
  verification_state text NOT NULL,
  parser_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS economic_calendar_source_archives (
  archive_id text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES economic_calendar_providers(provider_id),
  source_url text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  raw_checksum text NOT NULL,
  content_type text,
  byte_length integer NOT NULL,
  parser_version text NOT NULL,
  immutable_reference text NOT NULL,
  UNIQUE(provider_id,raw_checksum)
);

CREATE TABLE IF NOT EXISTS economic_calendar_v2_gate (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  manifest jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
