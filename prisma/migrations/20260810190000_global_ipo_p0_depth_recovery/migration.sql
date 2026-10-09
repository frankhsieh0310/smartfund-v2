-- GLOBAL_IPO_CALENDAR P0 professional depth contracts. Targeted and idempotent.
CREATE TABLE IF NOT EXISTS ipo_issuers (
  id uuid PRIMARY KEY, legal_name text NOT NULL, country text, jurisdiction text,
  regulator_id text, cik text, lei text, source text NOT NULL, source_type text NOT NULL,
  source_record_id text, source_url text, verification_status text NOT NULL,
  retrieved_at timestamptz NOT NULL, as_of_timestamp timestamptz NOT NULL,
  license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL', created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source, source_record_id)
);
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS issuer_id uuid REFERENCES ipo_issuers(id);
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS jurisdiction text;
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS filing_type text;
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS filing_date date;
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS expected_exchange text;
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS expected_ticker text;
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS expected_pricing_date date;
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS actual_pricing_date date;
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS expected_listing_date date;
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS actual_listing_date date;
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS date_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'REGULATOR_OFFICIAL';
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'VERIFIED_OFFICIAL';
ALTER TABLE ipo_offerings ADD COLUMN IF NOT EXISTS freshness_status text NOT NULL DEFAULT 'UNKNOWN';

CREATE TABLE IF NOT EXISTS ipo_events (
  id uuid PRIMARY KEY, ipo_id uuid NOT NULL REFERENCES ipo_offerings(id), event_type text NOT NULL,
  event_date date NOT NULL, effective_date date, source text NOT NULL, source_type text NOT NULL,
  source_record_id text, source_url text, verification_status text NOT NULL,
  retrieved_at timestamptz NOT NULL, as_of_timestamp timestamptz NOT NULL,
  license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL', source_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(ipo_id,event_type,source,source_record_id)
);
CREATE INDEX IF NOT EXISTS ipo_events_ipo_date_idx ON ipo_events(ipo_id,event_date);

CREATE TABLE IF NOT EXISTS ipo_revisions (
  id uuid PRIMARY KEY, ipo_id uuid NOT NULL REFERENCES ipo_offerings(id), filing_type text NOT NULL,
  filing_date date NOT NULL, source_record_id text NOT NULL, document_url text NOT NULL,
  previous_price_low numeric(28,10), previous_price_high numeric(28,10),
  new_price_low numeric(28,10), new_price_high numeric(28,10), previous_shares numeric(28,4),
  new_shares numeric(28,4), observed_at timestamptz NOT NULL, source text NOT NULL,
  source_type text NOT NULL, verification_status text NOT NULL, license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  source_payload jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source,source_record_id)
);
CREATE INDEX IF NOT EXISTS ipo_revisions_ipo_date_idx ON ipo_revisions(ipo_id,filing_date);

CREATE TABLE IF NOT EXISTS ipo_offering_terms (
  id uuid PRIMARY KEY, ipo_id uuid NOT NULL REFERENCES ipo_offerings(id), as_of_date date NOT NULL,
  price_type text NOT NULL, price_low numeric(28,10), price_high numeric(28,10), final_offer_price numeric(28,10),
  primary_shares numeric(28,4), secondary_shares numeric(28,4), total_shares_offered numeric(28,4),
  gross_proceeds numeric(28,2), net_proceeds numeric(28,2), currency text NOT NULL,
  over_allotment_shares numeric(28,4), greenshoe_percent numeric(12,6), pre_money_valuation numeric(28,2),
  post_money_valuation numeric(28,2), implied_market_cap numeric(28,2), source text NOT NULL,
  source_type text NOT NULL, source_record_id text, source_url text, verification_status text NOT NULL,
  retrieved_at timestamptz NOT NULL, as_of_timestamp timestamptz NOT NULL,
  license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(ipo_id,as_of_date,price_type,source)
);

CREATE TABLE IF NOT EXISTS ipo_underwriters (
  id uuid PRIMARY KEY, ipo_id uuid NOT NULL REFERENCES ipo_offerings(id), institution_name text NOT NULL,
  role text NOT NULL, role_order integer, source text NOT NULL, source_type text NOT NULL,
  source_record_id text, source_url text, verification_status text NOT NULL,
  retrieved_at timestamptz NOT NULL, license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(ipo_id,institution_name,role,source)
);

CREATE TABLE IF NOT EXISTS ipo_use_of_proceeds (
  id uuid PRIMARY KEY, ipo_id uuid NOT NULL REFERENCES ipo_offerings(id), category text NOT NULL,
  description text NOT NULL, amount numeric(28,2), percent numeric(12,6), currency text,
  source text NOT NULL, source_url text, verification_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ipo_stock_mappings (
  id uuid PRIMARY KEY, ipo_id uuid NOT NULL REFERENCES ipo_offerings(id), stock_id text REFERENCES stocks(id),
  match_method text, status text NOT NULL, match_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text, source_url text, verification_status text NOT NULL, missing_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(ipo_id)
);
CREATE INDEX IF NOT EXISTS ipo_stock_mappings_status_idx ON ipo_stock_mappings(status);

CREATE TABLE IF NOT EXISTS ipo_coverage (
  ipo_id uuid PRIMARY KEY REFERENCES ipo_offerings(id), identity_status text NOT NULL, issuer_status text NOT NULL,
  market_status text NOT NULL, offering_terms_status text NOT NULL, pricing_status text NOT NULL,
  listing_status text NOT NULL, revision_status text NOT NULL, underwriter_status text NOT NULL,
  stock_link_status text NOT NULL, performance_status text NOT NULL, provenance_status text NOT NULL,
  freshness_status text NOT NULL, coverage_status text NOT NULL, checked_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ipo_market_coverage (
  market text PRIMARY KEY, filings integer NOT NULL DEFAULT 0, priced integer NOT NULL DEFAULT 0,
  listed integer NOT NULL DEFAULT 0, withdrawn integer NOT NULL DEFAULT 0, postponed integer NOT NULL DEFAULT 0,
  coverage_start date, coverage_end date, history_status text NOT NULL, source_state text NOT NULL,
  checked_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ipo_performance (
  ipo_id uuid NOT NULL REFERENCES ipo_offerings(id), metric text NOT NULL, value numeric(24,10),
  observation_date date, source_stock_id text REFERENCES stocks(id), source text NOT NULL,
  verification_status text NOT NULL, calculated_at timestamptz NOT NULL, PRIMARY KEY(ipo_id,metric)
);
