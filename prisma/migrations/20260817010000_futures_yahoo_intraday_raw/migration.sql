ALTER TABLE futures_timeframe_bars ADD COLUMN IF NOT EXISTS adjusted_close NUMERIC;
ALTER TABLE futures_timeframe_bars ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE futures_timeframe_bars ADD COLUMN IF NOT EXISTS retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS futures_timeframe_bars_symbol_interval_time_idx
  ON futures_timeframe_bars(yahoo_symbol,timeframe,observed_at);

