ALTER TABLE corporate_actions
  ADD COLUMN IF NOT EXISTS ex_date date,
  ADD COLUMN IF NOT EXISTS record_date date,
  ADD COLUMN IF NOT EXISTS payment_date date,
  ADD COLUMN IF NOT EXISTS ratio_numerator numeric,
  ADD COLUMN IF NOT EXISTS ratio_denominator numeric,
  ADD COLUMN IF NOT EXISTS distribution_type text,
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS quality_status text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS raw_payload_checksum text,
  ADD COLUMN IF NOT EXISTS parser_version text NOT NULL DEFAULT 'legacy';

CREATE TABLE IF NOT EXISTS corporate_action_revisions (
  id uuid PRIMARY KEY,
  corporate_action_id uuid NOT NULL REFERENCES corporate_actions(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  revision_type text NOT NULL,
  old_payload_hash text,
  new_payload_hash text NOT NULL,
  changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  old_payload jsonb,
  new_payload jsonb NOT NULL,
  source text NOT NULL,
  source_record_id text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  supersedes_revision_id uuid REFERENCES corporate_action_revisions(id),
  verification_status text NOT NULL DEFAULT 'UNKNOWN',
  UNIQUE (corporate_action_id, revision_number)
);

CREATE TABLE IF NOT EXISTS corporate_action_related_securities (
  id uuid PRIMARY KEY,
  corporate_action_id uuid NOT NULL REFERENCES corporate_actions(id) ON DELETE CASCADE,
  relationship_type text NOT NULL,
  security_id text REFERENCES securities(id),
  role text NOT NULL,
  valid_from date,
  valid_to date,
  source text NOT NULL,
  source_record_id text NOT NULL,
  verification_state text NOT NULL DEFAULT 'UNRESOLVED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (corporate_action_id, relationship_type, security_id, source, source_record_id)
);

CREATE INDEX IF NOT EXISTS corporate_actions_event_dates_idx ON corporate_actions (ex_date, record_date, effective_date, payment_date);
CREATE INDEX IF NOT EXISTS corporate_action_revisions_event_idx ON corporate_action_revisions (corporate_action_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS corporate_action_related_security_idx ON corporate_action_related_securities (security_id, relationship_type);
