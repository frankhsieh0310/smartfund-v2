-- GLOBAL_SHARE_BUYBACK P0 program lifecycle enrichment. corporate_actions remains canonical event truth.
CREATE TABLE IF NOT EXISTS share_buyback_programs (
  id uuid PRIMARY KEY,
  security_id text NOT NULL REFERENCES securities(id),
  canonical_action_id uuid REFERENCES corporate_actions(id),
  program_key text NOT NULL UNIQUE,
  authorization_date date,
  announcement_date date,
  authorization_amount numeric(30,6),
  authorization_currency text,
  authorization_shares numeric(30,6),
  authorization_type text NOT NULL DEFAULT 'UNKNOWN',
  expiration_date date,
  status text NOT NULL DEFAULT 'UNKNOWN',
  source text NOT NULL,
  source_record_id text,
  source_url text,
  source_type text NOT NULL DEFAULT 'REGULATOR_OFFICIAL',
  first_seen_at timestamptz NOT NULL,
  last_verified_at timestamptz NOT NULL,
  verification_status text NOT NULL,
  license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  source_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS share_buyback_programs_security_date_idx ON share_buyback_programs(security_id,announcement_date);

CREATE TABLE IF NOT EXISTS share_buyback_program_revisions (
  id uuid PRIMARY KEY,
  program_id uuid NOT NULL REFERENCES share_buyback_programs(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  revision_type text NOT NULL,
  old_authorization_amount numeric(30,6), new_authorization_amount numeric(30,6),
  old_authorization_shares numeric(30,6), new_authorization_shares numeric(30,6),
  old_expiration_date date, new_expiration_date date,
  old_status text, new_status text NOT NULL,
  source text NOT NULL, source_record_id text, source_url text,
  verification_status text NOT NULL, source_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(program_id,revision_type,source,source_record_id)
);

CREATE TABLE IF NOT EXISTS share_buyback_executions (
  id uuid PRIMARY KEY,
  program_id uuid NOT NULL REFERENCES share_buyback_programs(id) ON DELETE CASCADE,
  security_id text NOT NULL REFERENCES securities(id),
  canonical_action_id uuid REFERENCES corporate_actions(id),
  period_start date, period_end date NOT NULL, execution_date date,
  shares_repurchased numeric(30,6), average_price numeric(30,10), value_repurhcased_placeholder numeric(30,6),
  value_repurchased numeric(30,6), currency text,
  remaining_authorization_amount numeric(30,6), remaining_authorization_shares numeric(30,6),
  amount_semantic text NOT NULL DEFAULT 'UNKNOWN_SEMANTIC',
  average_price_method text,
  source text NOT NULL, source_record_id text, source_url text, publication_date date,
  source_type text NOT NULL DEFAULT 'REGULATOR_OFFICIAL', verification_status text NOT NULL,
  retrieved_at timestamptz NOT NULL, as_of_timestamp timestamptz NOT NULL,
  license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL', source_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source,source_record_id,period_end)
);
ALTER TABLE share_buyback_executions DROP COLUMN IF EXISTS value_repurhcased_placeholder;
CREATE INDEX IF NOT EXISTS share_buyback_executions_program_period_idx ON share_buyback_executions(program_id,period_end);

CREATE TABLE IF NOT EXISTS share_buyback_issuer_coverage (
  security_id text PRIMARY KEY REFERENCES securities(id),
  market text, jurisdiction text, source_status text NOT NULL, program_check_status text NOT NULL,
  source_checked boolean NOT NULL DEFAULT false, has_buyback_program boolean,
  no_buyback_found_verified boolean NOT NULL DEFAULT false,
  program_count integer NOT NULL DEFAULT 0, active_program_count integer NOT NULL DEFAULT 0,
  first_program_date date, latest_program_date date,
  authorization_coverage text NOT NULL, execution_coverage text NOT NULL,
  shares_coverage text NOT NULL, value_coverage text NOT NULL, remaining_coverage text NOT NULL,
  completion_coverage text NOT NULL, revision_coverage text NOT NULL,
  provenance_status text NOT NULL, freshness_status text NOT NULL, history_status text NOT NULL,
  coverage_status text NOT NULL, checked_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS share_buyback_program_coverage (
  program_id uuid PRIMARY KEY REFERENCES share_buyback_programs(id) ON DELETE CASCADE,
  execution_record_count integer NOT NULL DEFAULT 0,
  cumulative_shares_repurchased numeric(30,6), cumulative_value_repurchased numeric(30,6),
  remaining_amount numeric(30,6), remaining_shares numeric(30,6), revision_count integer NOT NULL DEFAULT 0,
  authorization_status text NOT NULL, execution_status text NOT NULL, provenance_status text NOT NULL,
  freshness_status text NOT NULL, coverage_status text NOT NULL, checked_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS share_buyback_market_sources (
  jurisdiction text PRIMARY KEY, source_state text NOT NULL, official_sources jsonb NOT NULL,
  authorization_semantics text NOT NULL, execution_semantics text NOT NULL,
  license_status text NOT NULL, verification_status text NOT NULL, checked_at timestamptz NOT NULL
);
