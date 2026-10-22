-- Yahoo topHoldings can be source-valid while omitting a holdings as-of date.
-- retrieved_at remains the observation timestamp; quality metadata records DATE_UNKNOWN.
ALTER TABLE etf_holding_snapshots ALTER COLUMN effective_date DROP NOT NULL;
ALTER TABLE etf_holdings ALTER COLUMN effective_date DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS etf_holding_snapshots_unknown_date_source_record_key
ON etf_holding_snapshots(etf_id, source, source_record_id)
WHERE effective_date IS NULL AND source_record_id IS NOT NULL;
