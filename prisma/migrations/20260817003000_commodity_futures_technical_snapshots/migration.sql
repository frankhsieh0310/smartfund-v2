CREATE TABLE IF NOT EXISTS futures_technical_snapshots (
  id UUID PRIMARY KEY,
  root_id UUID NOT NULL REFERENCES futures_product_roots(id),
  yahoo_symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL CHECK (timeframe IN ('5m','15m','30m','1h','4h','1d','1w','1mo')),
  as_of TIMESTAMPTZ NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  states JSONB NOT NULL DEFAULT '{}'::jsonb,
  input_status TEXT NOT NULL DEFAULT 'READY',
  source TEXT NOT NULL,
  source_timeframe TEXT NOT NULL,
  source_input_version TEXT NOT NULL,
  calculation_version TEXT NOT NULL,
  known_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(root_id, timeframe, as_of, calculation_version)
);

CREATE INDEX IF NOT EXISTS futures_technical_snapshots_root_time_idx
  ON futures_technical_snapshots(root_id, timeframe, as_of);

CREATE TABLE IF NOT EXISTS futures_technical_timeframe_coverage (
  root_id UUID NOT NULL REFERENCES futures_product_roots(id),
  timeframe TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  source TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(root_id, timeframe)
);

