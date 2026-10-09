CREATE TABLE IF NOT EXISTS fx_forward_observations (
  id TEXT PRIMARY KEY,
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  pair TEXT NOT NULL,
  tenor TEXT NOT NULL CHECK (tenor IN ('ON','TN','SN','1W','2W','1M','2M','3M','6M','9M','1Y')),
  observation_date DATE NOT NULL,
  observation_timestamp TIMESTAMPTZ,
  spot NUMERIC(30,12),
  forward_points NUMERIC(30,12),
  forward_outright NUMERIC(30,12),
  points_convention TEXT,
  currency TEXT,
  source TEXT NOT NULL,
  source_record_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fx_forward_observations_value_check CHECK (forward_points IS NOT NULL OR forward_outright IS NOT NULL),
  CONSTRAINT fx_forward_observations_identity UNIQUE (pair, tenor, observation_date, source)
);
CREATE INDEX IF NOT EXISTS fx_forward_observations_pair_tenor_date_idx
  ON fx_forward_observations(pair, tenor, observation_date DESC);
