CREATE TABLE IF NOT EXISTS bond_etf_technical_analytics (
  etf_id text NOT NULL REFERENCES etfs(id), timeframe text NOT NULL,
  as_of_date date NOT NULL, metrics jsonb NOT NULL,
  trend_state text NOT NULL, momentum_state text NOT NULL,
  source text NOT NULL, input_semantics text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(etf_id,timeframe,as_of_date)
);
CREATE INDEX IF NOT EXISTS bond_etf_technical_timeframe_date_idx ON bond_etf_technical_analytics(timeframe,as_of_date);

CREATE TABLE IF NOT EXISTS bond_etf_research_snapshot (
  etf_id text PRIMARY KEY REFERENCES etfs(id), as_of_date date NOT NULL,
  category text, comparison jsonb NOT NULL, screening jsonb NOT NULL,
  yield_risk jsonb NOT NULL, relative_ranks jsonb NOT NULL,
  source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
