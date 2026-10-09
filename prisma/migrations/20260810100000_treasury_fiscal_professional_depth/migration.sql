CREATE TABLE IF NOT EXISTS fiscal_series (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  jurisdiction_id TEXT,
  metric_code TEXT NOT NULL,
  official_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  fiscal_category TEXT NOT NULL,
  frequency TEXT NOT NULL,
  unit TEXT NOT NULL,
  currency TEXT NOT NULL,
  seasonal_adjustment TEXT NOT NULL,
  source_agency TEXT NOT NULL,
  source_series_identifier TEXT NOT NULL,
  status TEXT NOT NULL,
  start_date DATE,
  end_date DATE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fiscal_series_identity UNIQUE(country_code, metric_code, source_series_identifier)
);

ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS fiscal_series_id TEXT;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS source_value DECIMAL(30,2);
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS source_metric TEXT;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS source_sign_convention TEXT;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS normalized_sign_convention TEXT;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS formula TEXT;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS formula_version TEXT;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS fiscal_year INTEGER;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS fiscal_month INTEGER;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS publication_date DATE;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS publication_date_time TIMESTAMP(3);
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS retrieved_at TIMESTAMP(3);
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS verification_status TEXT;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS quality_status TEXT;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS parser_version TEXT;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS checksum TEXT;
ALTER TABLE treasury_fiscal_observations ADD COLUMN IF NOT EXISTS freshness_status TEXT;

CREATE TABLE IF NOT EXISTS fiscal_observation_vintages (
  id TEXT PRIMARY KEY,
  fiscal_series_id TEXT NOT NULL,
  reference_period DATE NOT NULL,
  published_at TIMESTAMP(3),
  value DECIMAL(30,2) NOT NULL,
  source_value DECIMAL(30,2) NOT NULL,
  revision_sequence INTEGER NOT NULL DEFAULT 1,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  supersedes_id TEXT,
  source_record_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  retrieved_at TIMESTAMP(3) NOT NULL,
  verification_status TEXT NOT NULL,
  quality_status TEXT NOT NULL,
  checksum TEXT,
  parser_version TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fiscal_observation_vintage_identity UNIQUE(fiscal_series_id, reference_period, source_record_id)
);
CREATE INDEX IF NOT EXISTS fiscal_observation_vintages_period_idx ON fiscal_observation_vintages(fiscal_series_id, reference_period, revision_sequence);

CREATE TABLE IF NOT EXISTS fiscal_derived_analytics (
  id TEXT PRIMARY KEY,
  fiscal_series_id TEXT NOT NULL,
  reference_period DATE NOT NULL,
  analytic_code TEXT NOT NULL,
  value DECIMAL(38,10),
  unit TEXT NOT NULL,
  observation_type TEXT NOT NULL DEFAULT 'DERIVED_ANALYTIC',
  formula_version TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fiscal_derived_analytics_identity UNIQUE(fiscal_series_id, reference_period, analytic_code)
);

INSERT INTO fiscal_series(id,country_code,metric_code,official_name,display_name,fiscal_category,frequency,unit,currency,seasonal_adjustment,source_agency,source_series_identifier,status)
VALUES
('US_TOTAL_RECEIPTS','US','TOTAL_RECEIPTS','Current Month Gross Receipts Amount','Total Receipts','RECEIPTS','MONTHLY','USD','USD','NOT_SEASONALLY_ADJUSTED','U.S. Department of the Treasury, Bureau of the Fiscal Service','mts_table_1:current_month_gross_rcpt_amt','ACTIVE'),
('US_TOTAL_OUTLAYS','US','TOTAL_OUTLAYS','Current Month Gross Outlay Amount','Total Outlays','OUTLAYS','MONTHLY','USD','USD','NOT_SEASONALLY_ADJUSTED','U.S. Department of the Treasury, Bureau of the Fiscal Service','mts_table_1:current_month_gross_outly_amt','ACTIVE'),
('US_BUDGET_SURPLUS_DEFICIT','US','BUDGET_SURPLUS_DEFICIT','Current Month Deficit Surplus Amount','Budget Surplus / Deficit','BALANCE','MONTHLY','USD','USD','NOT_SEASONALLY_ADJUSTED','U.S. Department of the Treasury, Bureau of the Fiscal Service','mts_table_1:current_month_dfct_sur_amt','ACTIVE')
ON CONFLICT(country_code,metric_code,source_series_identifier) DO UPDATE SET updated_at=now();

UPDATE treasury_fiscal_observations SET
  source_value=value,
  value=-value,
  metric_code='BUDGET_SURPLUS_DEFICIT',
  metric_name='Budget Surplus / Deficit',
  fiscal_series_id='US_BUDGET_SURPLUS_DEFICIT',
  source_metric='current_month_dfct_sur_amt',
  source_sign_convention='DEFICIT_POSITIVE_SURPLUS_NEGATIVE',
  normalized_sign_convention='SURPLUS_POSITIVE_DEFICIT_NEGATIVE',
  formula='normalized_value = -source_value = receipts - outlays',
  formula_version='MTS_BALANCE_V1',
  updated_at=now()
WHERE metric_code='BUDGET_BALANCE';

UPDATE treasury_fiscal_observations SET
  fiscal_series_id=CASE metric_code WHEN 'TOTAL_RECEIPTS' THEN 'US_TOTAL_RECEIPTS' WHEN 'TOTAL_OUTLAYS' THEN 'US_TOTAL_OUTLAYS' WHEN 'BUDGET_SURPLUS_DEFICIT' THEN 'US_BUDGET_SURPLUS_DEFICIT' END,
  source_value=COALESCE(source_value,value), source_metric=official_field,
  source_sign_convention=COALESCE(source_sign_convention,'SOURCE_REPORTED_POSITIVE_AMOUNT'),
  normalized_sign_convention=COALESCE(normalized_sign_convention,'SOURCE_VALUE_UNCHANGED'),
  formula=COALESCE(formula,'normalized_value = source_value'), formula_version=COALESCE(formula_version,'MTS_DIRECT_V1'),
  fiscal_year=CASE WHEN EXTRACT(MONTH FROM observation_date)>=10 THEN EXTRACT(YEAR FROM observation_date)::int+1 ELSE EXTRACT(YEAR FROM observation_date)::int END,
  fiscal_month=((EXTRACT(MONTH FROM observation_date)::int+2)%12)+1,
  source_url='https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/mts/mts_table_1',
  retrieved_at=COALESCE(retrieved_at,updated_at), verification_status='VERIFIED_OFFICIAL', quality_status='PASS', parser_version='MTS_TABLE_1_V2', freshness_status='CURRENT'
WHERE fiscal_series_id IS NULL OR retrieved_at IS NULL;

UPDATE treasury_fiscal_observations
SET freshness_status='UNKNOWN'
WHERE source='US_TREASURY_FISCAL_DATA_MTS_TABLE_1' AND publication_date IS NULL;
