CREATE TABLE IF NOT EXISTS etf_yahoo_observations (
  etf_id text NOT NULL REFERENCES etfs(id),
  metric_type text NOT NULL,
  period text NOT NULL DEFAULT '',
  as_of_date date NOT NULL,
  value numeric(30,12),
  text_value text,
  json_value jsonb,
  unit text,
  source text NOT NULL DEFAULT 'YAHOO',
  known_at timestamptz NOT NULL,
  source_record_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (etf_id, metric_type, period, as_of_date, source)
);
CREATE INDEX IF NOT EXISTS etf_yahoo_observations_metric_date_idx ON etf_yahoo_observations(metric_type, as_of_date);

CREATE TABLE IF NOT EXISTS etf_yahoo_terminal_status (
  etf_id text PRIMARY KEY REFERENCES etfs(id),
  state text NOT NULL,
  available_fields integer NOT NULL DEFAULT 0,
  unavailable_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text NOT NULL DEFAULT 'YAHOO',
  checked_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
