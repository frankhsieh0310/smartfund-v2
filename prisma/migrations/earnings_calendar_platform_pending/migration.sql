-- REVIEW-ONLY: Production migration approval is still false in platform config.
CREATE TABLE earnings_calendar_events (
 id uuid PRIMARY KEY, event_key text NOT NULL UNIQUE, stock_id text NOT NULL REFERENCES stocks(id) ON DELETE CASCADE, event_type text NOT NULL,
 fiscal_year integer, fiscal_quarter text, fiscal_period_start_date date, fiscal_period_end_date date, reported_currency text,
 announcement_date date, announcement_time text, announcement_timezone text, press_release_date date, webcast_date date, estimated_future_date date,
 announcement_date_type text NOT NULL, date_status text NOT NULL, release_timing text NOT NULL DEFAULT 'UNKNOWN', confirmed_status text NOT NULL,
 filing_date date, filing_id text, filing_url text, press_release_url text, earnings_call_url text,
 source text NOT NULL, source_type text NOT NULL, source_record_id text, source_url text, parser_version text NOT NULL, source_checksum text,
 retrieved_at timestamptz NOT NULL, as_of_timestamp timestamptz NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL,
 verification_status text NOT NULL, quality_status text NOT NULL, freshness_status text NOT NULL, missing_reason text, missing_fields jsonb, license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
 UNIQUE(stock_id,source,source_record_id)
);
CREATE INDEX earnings_calendar_events_date_status_idx ON earnings_calendar_events(announcement_date,confirmed_status);
CREATE INDEX earnings_calendar_events_stock_period_idx ON earnings_calendar_events(stock_id,fiscal_period_end_date);
CREATE TABLE earnings_calendar_event_revisions (
 id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES earnings_calendar_events(id) ON DELETE CASCADE, observed_at timestamptz NOT NULL,
 old_announcement_date date, new_announcement_date date, old_status text, new_status text NOT NULL, revision_reason text, revision_type text NOT NULL,
 supersedes_revision_id uuid REFERENCES earnings_calendar_event_revisions(id) ON DELETE SET NULL, source text NOT NULL, source_record_id text, source_url text,
 verification_status text NOT NULL, parser_version text NOT NULL, source_checksum text,
 UNIQUE(event_id,observed_at,source)
);
CREATE INDEX earnings_calendar_event_revisions_event_observed_idx ON earnings_calendar_event_revisions(event_id,observed_at);
CREATE TABLE earnings_actual_results (
 id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES earnings_calendar_events(id) ON DELETE CASCADE, stock_id text NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
 fiscal_period_end_date date NOT NULL, eps_actual numeric(30,8), eps_type text, revenue_actual numeric(30,8), revenue_currency text,
 revenue_reported_value numeric(30,8), revenue_reported_unit text, net_income numeric(30,8), operating_income numeric(30,8), reported_at timestamptz NOT NULL,
 source text NOT NULL, source_type text NOT NULL, source_record_id text, source_url text, verification_status text NOT NULL,
 parser_version text NOT NULL, source_checksum text, license_status text NOT NULL DEFAULT 'PUBLIC_OFFICIAL',
 UNIQUE(event_id,source,source_record_id)
);
CREATE INDEX earnings_actual_results_stock_period_idx ON earnings_actual_results(stock_id,fiscal_period_end_date);
CREATE TABLE earnings_estimates (
 id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES earnings_calendar_events(id) ON DELETE CASCADE, metric_code text NOT NULL, metric_semantic text NOT NULL,
 estimate_value numeric(30,8) NOT NULL, currency text, estimate_type text NOT NULL, as_of_timestamp timestamptz NOT NULL,
 provider text NOT NULL, source text NOT NULL, source_record_id text, source_url text, verification_status text NOT NULL, license_status text NOT NULL,
 UNIQUE(event_id,metric_code,metric_semantic,as_of_timestamp,provider)
);
CREATE INDEX earnings_estimates_event_metric_idx ON earnings_estimates(event_id,metric_code);
CREATE TABLE earnings_coverage (
 stock_id text PRIMARY KEY REFERENCES stocks(id) ON DELETE CASCADE, event_coverage_status text NOT NULL,
 event_source_state text NOT NULL, historical_event_state text NOT NULL, upcoming_event_state text NOT NULL, actual_result_state text NOT NULL,
 revision_state text NOT NULL, filing_link_state text NOT NULL, guidance_link_state text NOT NULL, estimate_state text NOT NULL,
 provenance_state text NOT NULL, freshness_state text NOT NULL, upcoming_event_available boolean NOT NULL DEFAULT false,
 historical_event_count integer NOT NULL DEFAULT 0, first_historical_date date, latest_historical_date date, actual_result_count integer NOT NULL DEFAULT 0,
 eps_actual_status text NOT NULL, revenue_actual_status text NOT NULL, estimate_status text NOT NULL, guidance_status text NOT NULL,
 revision_lineage_status text NOT NULL, filing_url_status text NOT NULL, release_timing_status text NOT NULL, freshness_status text NOT NULL,
 provenance_status text NOT NULL, missing_reason text, coverage_status text NOT NULL, last_evaluated_at timestamptz NOT NULL
);
CREATE INDEX earnings_coverage_status_missing_idx ON earnings_coverage(coverage_status,missing_reason);
ALTER TABLE company_guidance ADD COLUMN event_id uuid REFERENCES earnings_calendar_events(id) ON DELETE SET NULL;
CREATE INDEX company_guidance_event_id_idx ON company_guidance(event_id);
