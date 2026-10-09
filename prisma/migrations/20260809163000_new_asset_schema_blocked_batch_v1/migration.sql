CREATE TABLE IF NOT EXISTS fund_holdings (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  security_id TEXT REFERENCES securities(id) ON DELETE SET NULL,
  holding_name TEXT,
  isin TEXT,
  cusip TEXT,
  amount NUMERIC(30,6),
  shares NUMERIC(30,6),
  market_value NUMERIC(30,6),
  weight NUMERIC(12,8),
  currency TEXT,
  report_date DATE NOT NULL,
  source TEXT NOT NULL,
  source_holding_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fund_holdings_identity UNIQUE (fund_id, report_date, source, source_holding_id)
);
CREATE INDEX IF NOT EXISTS fund_holdings_fund_report_idx ON fund_holdings(fund_id, report_date);
CREATE INDEX IF NOT EXISTS fund_holdings_security_idx ON fund_holdings(security_id);

CREATE TABLE IF NOT EXISTS fund_flows (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  observation_date DATE NOT NULL,
  subscription NUMERIC(30,6),
  redemption NUMERIC(30,6),
  net_flow NUMERIC(30,6),
  aum NUMERIC(30,6),
  currency TEXT,
  flow_type TEXT NOT NULL CHECK (flow_type IN ('OFFICIAL','DERIVED')),
  method TEXT NOT NULL,
  source TEXT NOT NULL,
  source_record_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fund_flows_identity UNIQUE (fund_id, observation_date, source, flow_type, source_record_id)
);
CREATE INDEX IF NOT EXISTS fund_flows_fund_date_idx ON fund_flows(fund_id, observation_date);

CREATE TABLE IF NOT EXISTS etf_asset_metrics (
  id TEXT PRIMARY KEY,
  etf_id TEXT NOT NULL REFERENCES etfs(id) ON DELETE CASCADE,
  observation_date DATE NOT NULL,
  aum NUMERIC(30,6),
  shares_outstanding NUMERIC(30,6),
  nav NUMERIC(30,10),
  currency TEXT,
  source TEXT NOT NULL,
  source_record_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT etf_asset_metrics_identity UNIQUE (etf_id, observation_date, source, source_record_id)
);
CREATE INDEX IF NOT EXISTS etf_asset_metrics_etf_date_idx ON etf_asset_metrics(etf_id, observation_date);

CREATE TABLE IF NOT EXISTS yield_curves (
  id TEXT PRIMARY KEY,
  curve_code TEXT NOT NULL,
  country TEXT NOT NULL,
  currency TEXT,
  curve_type TEXT NOT NULL,
  curve_date DATE NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT yield_curves_identity UNIQUE (curve_code, curve_date, source)
);
CREATE INDEX IF NOT EXISTS yield_curves_country_date_idx ON yield_curves(country, curve_date);

CREATE TABLE IF NOT EXISTS yield_curve_points (
  id TEXT PRIMARY KEY,
  curve_id TEXT NOT NULL REFERENCES yield_curves(id) ON DELETE CASCADE,
  tenor TEXT NOT NULL,
  tenor_months INTEGER,
  tenor_days INTEGER,
  yield NUMERIC(18,8) NOT NULL,
  observation_date DATE NOT NULL,
  source_series TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT yield_curve_points_identity UNIQUE (curve_id, tenor)
);
CREATE INDEX IF NOT EXISTS yield_curve_points_date_idx ON yield_curve_points(observation_date);

CREATE TABLE IF NOT EXISTS treasury_auctions (
  id TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  security_type TEXT NOT NULL,
  cusip TEXT,
  auction_date DATE NOT NULL,
  issue_date DATE,
  maturity_date DATE,
  term TEXT,
  amount_offered NUMERIC(30,2),
  amount_accepted NUMERIC(30,2),
  high_yield NUMERIC(18,8),
  high_rate NUMERIC(18,8),
  bid_to_cover NUMERIC(18,8),
  direct_bidder_pct NUMERIC(18,8),
  indirect_bidder_pct NUMERIC(18,8),
  currency TEXT,
  source TEXT NOT NULL,
  source_auction_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT treasury_auctions_identity UNIQUE (source, source_auction_id)
);
CREATE INDEX IF NOT EXISTS treasury_auctions_country_date_idx ON treasury_auctions(country, auction_date);

CREATE TABLE IF NOT EXISTS corporate_issuance_events (
  id TEXT PRIMARY KEY,
  issuer_id TEXT REFERENCES securities(id) ON DELETE SET NULL,
  issuer_name TEXT NOT NULL,
  instrument_type TEXT NOT NULL CHECK (instrument_type = 'CORPORATE_BOND'),
  announcement_date DATE,
  pricing_date DATE,
  issue_date DATE,
  amount NUMERIC(30,2),
  currency TEXT,
  coupon NUMERIC(18,8),
  maturity_date DATE,
  seniority TEXT,
  isin TEXT,
  cusip TEXT,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT corporate_issuance_identity UNIQUE (source, source_event_id)
);
CREATE INDEX IF NOT EXISTS corporate_issuance_issuer_date_idx ON corporate_issuance_events(issuer_id, issue_date);

