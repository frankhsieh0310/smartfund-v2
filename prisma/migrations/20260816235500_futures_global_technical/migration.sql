CREATE TABLE IF NOT EXISTS futures_timeframe_bars (
  root_id UUID NOT NULL REFERENCES futures_product_roots(id) ON DELETE CASCADE,
  yahoo_symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  open NUMERIC, high NUMERIC, low NUMERIC, close NUMERIC, volume NUMERIC,
  source TEXT NOT NULL,
  is_resampled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (yahoo_symbol,timeframe,observed_at)
);
CREATE INDEX IF NOT EXISTS futures_timeframe_bars_root_tf_idx ON futures_timeframe_bars(root_id,timeframe,observed_at);

CREATE TABLE IF NOT EXISTS futures_technical_analytics (
  root_id UUID NOT NULL REFERENCES futures_product_roots(id) ON DELETE CASCADE,
  yahoo_symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  metrics JSONB NOT NULL,
  trend_state TEXT,
  momentum_state TEXT,
  volatility_state TEXT,
  price_volume_state TEXT,
  drawdown NUMERIC,
  oi_disposition TEXT NOT NULL DEFAULT 'SOURCE_LIMITED',
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (yahoo_symbol,timeframe,observed_at)
);
CREATE INDEX IF NOT EXISTS futures_technical_root_tf_idx ON futures_technical_analytics(root_id,timeframe,observed_at);

CREATE TABLE IF NOT EXISTS futures_multi_timeframe_alignment (
  root_id UUID NOT NULL REFERENCES futures_product_roots(id) ON DELETE CASCADE,
  yahoo_symbol TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  alignment TEXT NOT NULL,
  bullish_timeframes INTEGER NOT NULL,
  bearish_timeframes INTEGER NOT NULL,
  available_timeframes INTEGER NOT NULL,
  timeframe_states JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (yahoo_symbol,observed_at)
);
