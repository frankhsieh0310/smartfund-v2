ALTER TABLE etf_history ADD COLUMN IF NOT EXISTS open numeric(24,8);
ALTER TABLE etf_history ADD COLUMN IF NOT EXISTS high numeric(24,8);
ALTER TABLE etf_history ADD COLUMN IF NOT EXISTS low numeric(24,8);
ALTER TABLE etf_history ADD COLUMN IF NOT EXISTS close numeric(24,8);
ALTER TABLE etf_history ADD COLUMN IF NOT EXISTS adjusted_close numeric(24,8);
ALTER TABLE etf_history ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE etf_history ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE etf_history ADD COLUMN IF NOT EXISTS known_at timestamptz;
CREATE INDEX IF NOT EXISTS etf_history_complete_ohlc_idx ON etf_history(etf_id,date) WHERE open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL AND adjusted_close IS NOT NULL;
