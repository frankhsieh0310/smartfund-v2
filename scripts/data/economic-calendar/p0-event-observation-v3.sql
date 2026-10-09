CREATE TABLE IF NOT EXISTS economic_calendar_us_core_series (
  series_id text PRIMARY KEY REFERENCES economic_series(id),
  release_family text NOT NULL,
  official_agency_id text NOT NULL REFERENCES economic_calendar_providers(provider_id),
  mapping_state text NOT NULL CHECK(mapping_state IN ('VERIFIED','UNRESOLVED','AMBIGUOUS')),
  mapping_rule text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS economic_event_reconciliation (
  event_id text PRIMARY KEY REFERENCES economic_release_events(event_id) ON DELETE CASCADE,
  reconciliation_state text NOT NULL CHECK(reconciliation_state IN ('RELEASED_VERIFIED','PAST_SCHEDULE_METADATA_ONLY','UNRESOLVED','SOURCE_CONSTRAINED','SCHEDULED_FUTURE','CANCELLED','RESCHEDULED')),
  release_evidence_url text,
  release_evidence_checksum text,
  parser_version text NOT NULL,
  verified_at timestamptz NOT NULL,
  actual_freshness_state text NOT NULL CHECK(actual_freshness_state IN ('WAITING_FOR_ACTUAL','ACTUAL_AVAILABLE','SOURCE_DELAYED','RELEASE_UNVERIFIED','NOT_APPLICABLE'))
);

CREATE TABLE IF NOT EXISTS economic_event_observation_links (
  link_id text PRIMARY KEY,
  event_id text NOT NULL UNIQUE REFERENCES economic_release_events(event_id) ON DELETE CASCADE,
  series_id text NOT NULL REFERENCES economic_series(id),
  economic_value_id text NOT NULL REFERENCES economic_values(id),
  reference_period_start date NOT NULL,
  observation_date date NOT NULL,
  actual_value numeric NOT NULL,
  actual_link_state text NOT NULL,
  previous_link_state text NOT NULL,
  revision_state text NOT NULL,
  actual_source_url text,
  actual_source_version text,
  verification_state text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS economic_calendar_source_states (
  jurisdiction_code text PRIMARY KEY,
  source_state text NOT NULL CHECK(source_state IN ('SOURCE_PENDING','SOURCE_DISCOVERY_PENDING','ACCESS_BLOCKED','LICENSE_CONSTRAINED','NOT_IMPLEMENTED','NO_COMPARABLE_CALENDAR','ACTIVE_VERIFIED')),
  reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS economic_calendar_coverage_v3 (
  series_id text PRIMARY KEY REFERENCES economic_series(id),
  identity_state text NOT NULL,
  calendar_state text NOT NULL,
  upcoming_state text NOT NULL,
  historical_release_state text NOT NULL,
  actual_link_state text NOT NULL,
  previous_link_state text NOT NULL,
  revision_state text NOT NULL,
  forecast_state text NOT NULL,
  provenance_state text NOT NULL,
  freshness_state text NOT NULL,
  detail_state text NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now()
);
