ALTER TABLE economic_value_vintages
  ADD COLUMN IF NOT EXISTS realtime_start date,
  ADD COLUMN IF NOT EXISTS realtime_end date,
  ADD COLUMN IF NOT EXISTS vintage_type text,
  ADD COLUMN IF NOT EXISTS revision_sequence integer,
  ADD COLUMN IF NOT EXISTS first_release_value numeric,
  ADD COLUMN IF NOT EXISTS previous_vintage_value numeric,
  ADD COLUMN IF NOT EXISTS latest_revised_value numeric,
  ADD COLUMN IF NOT EXISTS revision_amount numeric,
  ADD COLUMN IF NOT EXISTS revision_percent numeric;

UPDATE economic_value_vintages
SET vintage_type = CASE
  WHEN source LIKE 'FIRST_OBSERVED:%' THEN 'FIRST_OBSERVED_BY_SMARTFUND'
  WHEN release_event_id IS NOT NULL THEN 'EVENT_AS_OF_TIMESTAMP'
  ELSE 'SOURCE_CLASSIFICATION_PENDING'
END
WHERE vintage_type IS NULL;

CREATE INDEX IF NOT EXISTS economic_value_vintages_true_pit_idx
  ON economic_value_vintages(series_id, reference_date, realtime_start, realtime_end)
  WHERE vintage_type = 'TRUE_SOURCE_VINTAGE';
