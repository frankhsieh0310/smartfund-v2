-- FX_FORWARD_POINTS P0 semantic recovery only.
-- Does not alter FX spot, cross-currency basis, OIS, policy rates, or website relations.

CREATE TABLE IF NOT EXISTS fx_forward_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('OFFICIAL_DIRECT','APPROVED_PUBLIC','LICENSED','DERIVED','UNVERIFIED')),
  base_url TEXT,
  license_status TEXT NOT NULL,
  automation_status TEXT NOT NULL,
  current_status TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  latest_source_date DATE,
  verified_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fx_forward_instruments (
  id TEXT PRIMARY KEY,
  base_currency_id TEXT NOT NULL,
  quote_currency_id TEXT NOT NULL,
  canonical_pair TEXT NOT NULL,
  tenor TEXT NOT NULL CHECK (tenor IN ('ON','TN','SN','1W','2W','1M','2M','3M','6M','9M','1Y')),
  tenor_months INTEGER,
  tenor_days INTEGER,
  instrument_type TEXT NOT NULL CHECK (instrument_type IN ('FX_FORWARD','NDF')),
  deliverability TEXT NOT NULL CHECK (deliverability IN ('DELIVERABLE_FORWARD','NDF','UNKNOWN')),
  quote_convention TEXT NOT NULL,
  pip_scale NUMERIC(20,4) NOT NULL,
  settlement_convention TEXT,
  spot_lag TEXT,
  calendar_convention TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  preferred_source_id TEXT REFERENCES fx_forward_sources(id),
  verification_status TEXT NOT NULL DEFAULT 'CONFIGURED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canonical_pair, tenor)
);

ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS forward_instrument_id TEXT;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS value_type TEXT;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS spot_at_observation NUMERIC(30,12);
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS bid_outright NUMERIC(30,12);
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS ask_outright NUMERIC(30,12);
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS bid_points NUMERIC(30,12);
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS ask_points NUMERIC(30,12);
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS quote_type TEXT;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS source_id TEXT;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS as_of_datetime TIMESTAMPTZ;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS retrieved_at TIMESTAMPTZ;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS verification_status TEXT;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS quality_status TEXT;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS freshness_status TEXT;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS direct_or_derived TEXT;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS checksum TEXT;
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS raw_difference NUMERIC(30,12);
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS pip_scale NUMERIC(20,4);
ALTER TABLE fx_forward_observations ADD COLUMN IF NOT EXISTS formula_version TEXT;

CREATE TABLE IF NOT EXISTS fx_forward_derivation_lineage (
  id TEXT PRIMARY KEY,
  derivation_type TEXT NOT NULL,
  forward_observation_id TEXT NOT NULL REFERENCES fx_forward_observations(id),
  spot_observation_id TEXT NOT NULL,
  formula_version TEXT NOT NULL,
  raw_difference NUMERIC(30,12) NOT NULL,
  pip_scale NUMERIC(20,4) NOT NULL,
  normalized_forward_points NUMERIC(30,12) NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (forward_observation_id, formula_version)
);

CREATE TABLE IF NOT EXISTS fx_forward_coverage (
  forward_instrument_id TEXT PRIMARY KEY REFERENCES fx_forward_instruments(id),
  identity_ready BOOLEAN NOT NULL DEFAULT false,
  current_outright_ready BOOLEAN NOT NULL DEFAULT false,
  current_points_ready BOOLEAN NOT NULL DEFAULT false,
  spot_link_ready BOOLEAN NOT NULL DEFAULT false,
  history_ready BOOLEAN NOT NULL DEFAULT false,
  history_count BIGINT NOT NULL DEFAULT 0,
  first_date DATE,
  latest_date DATE,
  freshness TEXT NOT NULL DEFAULT 'UNKNOWN',
  direct_or_derived TEXT,
  source_verified BOOLEAN NOT NULL DEFAULT false,
  convention_ready BOOLEAN NOT NULL DEFAULT false,
  provenance_ready BOOLEAN NOT NULL DEFAULT false,
  analytics_ready BOOLEAN NOT NULL DEFAULT false,
  missing_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fx_forward_work_items (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  pair TEXT,
  tenor TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  blocker TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO fx_forward_sources(id,name,source_type,base_url,license_status,automation_status,current_status,capabilities,latest_source_date,verified_at,metadata)
VALUES
 ('BANK_OF_ENGLAND_IADB','Bank of England IADB','OFFICIAL_DIRECT','https://www.bankofengland.co.uk/boeapps/database/','PUBLIC','AUTOMATED','HISTORICAL_SOURCE_ONLY','["FORWARD_OUTRIGHT","HISTORY"]','2021-06-30',now(),'{"series":["XUDLDS1","XUDLDS3","XUDLDS6","XUDLDSY"],"runnerHealthRule":"SUCCESS_NO_NEW_DATA"}'),
 ('LSEG_WMR','LSEG WMR FX Benchmarks','LICENSED','https://www.lseg.com/en/ftse-russell/benchmarks/wmr-fx-benchmarks','LICENSE_REQUIRED','LICENSE_BLOCKED','CURRENT_LICENSE_BLOCKED','["SPOT","FORWARD_OUTRIGHT","FORWARD_POINTS","NDF","HISTORY"]',NULL,now(),'{"coverage":"daily closing forwards and NDFs","access":"data feed/API or authorised redistributor"}')
ON CONFLICT(id) DO UPDATE SET current_status=EXCLUDED.current_status,automation_status=EXCLUDED.automation_status,latest_source_date=EXCLUDED.latest_source_date,verified_at=EXCLUDED.verified_at,metadata=EXCLUDED.metadata,updated_at=now();

INSERT INTO fx_forward_instruments(id,base_currency_id,quote_currency_id,canonical_pair,tenor,tenor_months,instrument_type,deliverability,quote_convention,pip_scale,status,preferred_source_id,verification_status)
SELECT pair || '-' || tenor, base_ccy, quote_ccy, pair, tenor, months, 'FX_FORWARD', 'UNKNOWN', 'QUOTE_UNITS_PER_BASE', pip_scale, 'ACTIVE', 'LSEG_WMR', 'PAIR_AND_PIP_CONVENTION_CONFIGURED_SOURCE_ACCESS_PENDING'
FROM (VALUES
 ('EURUSD','EUR','USD',10000::numeric),('GBPUSD','GBP','USD',10000::numeric),('USDJPY','USD','JPY',100::numeric)
) p(pair,base_ccy,quote_ccy,pip_scale)
CROSS JOIN (VALUES ('1M',1),('3M',3),('6M',6),('1Y',12)) t(tenor,months)
ON CONFLICT(canonical_pair,tenor) DO UPDATE SET quote_convention=EXCLUDED.quote_convention,pip_scale=EXCLUDED.pip_scale,preferred_source_id=EXCLUDED.preferred_source_id,updated_at=now();

UPDATE fx_forward_observations o SET
  forward_instrument_id=o.pair || '-' || o.tenor,
  value_type='FORWARD_OUTRIGHT',
  quote_type='MID',
  source_id='BANK_OF_ENGLAND_IADB',
  source_type='OFFICIAL_DIRECT',
  source_url='https://www.bankofengland.co.uk/boeapps/database/',
  as_of_datetime=o.observation_date::timestamp AT TIME ZONE 'UTC',
  retrieved_at=o.created_at,
  verification_status='SOURCE_RECORD_VERIFIED',
  quality_status='VALID_HISTORICAL_OUTRIGHT',
  freshness_status='SOURCE_DISCONTINUED',
  direct_or_derived='DIRECT_FORWARD_OUTRIGHT',
  pip_scale=CASE WHEN o.quote_currency='JPY' THEN 100 ELSE 10000 END
WHERE o.source='BANK_OF_ENGLAND_IADB';

ALTER TABLE fx_forward_observations ALTER COLUMN value_type SET NOT NULL;
ALTER TABLE fx_forward_observations DROP CONSTRAINT IF EXISTS fx_forward_observations_value_type_check;
ALTER TABLE fx_forward_observations ADD CONSTRAINT fx_forward_observations_value_type_check CHECK (
  (value_type='FORWARD_OUTRIGHT' AND forward_outright IS NOT NULL) OR
  (value_type='FORWARD_POINTS' AND forward_points IS NOT NULL) OR
  (value_type='FORWARD_OUTRIGHT_AND_POINTS' AND forward_outright IS NOT NULL AND forward_points IS NOT NULL)
);
ALTER TABLE fx_forward_observations DROP CONSTRAINT IF EXISTS fx_forward_observations_direct_derived_check;
ALTER TABLE fx_forward_observations ADD CONSTRAINT fx_forward_observations_direct_derived_check CHECK (
  direct_or_derived IS NULL OR direct_or_derived IN ('DIRECT_FORWARD_OUTRIGHT','DIRECT_FORWARD_POINTS','DERIVED_FORWARD_POINTS')
);

INSERT INTO fx_forward_coverage(forward_instrument_id,identity_ready,current_outright_ready,current_points_ready,spot_link_ready,history_ready,history_count,first_date,latest_date,freshness,direct_or_derived,source_verified,convention_ready,provenance_ready,analytics_ready,missing_reasons)
SELECT i.id,true,false,false,false,false,COUNT(o.id),MIN(o.observation_date),MAX(o.observation_date),
 CASE WHEN COUNT(o.id)>0 THEN 'SOURCE_DISCONTINUED' ELSE 'LICENSE_BLOCKED' END,
 CASE WHEN COUNT(o.id)>0 THEN 'DIRECT_FORWARD_OUTRIGHT' END,
 COUNT(o.id)>0,true,COUNT(o.id)>0,false,
 CASE WHEN COUNT(o.id)>0 THEN '["CURRENT_SOURCE_LICENSE_BLOCKED","NO_CURRENT_POINTS","NO_VERIFIED_CURRENT_SPOT","INSUFFICIENT_HISTORY"]'::jsonb ELSE '["CURRENT_SOURCE_LICENSE_BLOCKED","NO_OBSERVATIONS","NO_VERIFIED_SPOT","NO_HISTORY"]'::jsonb END
FROM fx_forward_instruments i LEFT JOIN fx_forward_observations o ON o.forward_instrument_id=i.id
GROUP BY i.id
ON CONFLICT(forward_instrument_id) DO UPDATE SET identity_ready=EXCLUDED.identity_ready,current_outright_ready=EXCLUDED.current_outright_ready,current_points_ready=EXCLUDED.current_points_ready,spot_link_ready=EXCLUDED.spot_link_ready,history_ready=EXCLUDED.history_ready,history_count=EXCLUDED.history_count,first_date=EXCLUDED.first_date,latest_date=EXCLUDED.latest_date,freshness=EXCLUDED.freshness,direct_or_derived=EXCLUDED.direct_or_derived,source_verified=EXCLUDED.source_verified,convention_ready=EXCLUDED.convention_ready,provenance_ready=EXCLUDED.provenance_ready,analytics_ready=EXCLUDED.analytics_ready,missing_reasons=EXCLUDED.missing_reasons,checked_at=now();

INSERT INTO fx_forward_work_items(id,dedupe_key,kind,status,blocker,payload)
SELECT md5(kind),kind,kind,status,blocker,payload FROM (VALUES
 ('CURRENT_SOURCE','BLOCKED','LICENSE_REQUIRED','{"source":"LSEG_WMR","launchPairs":["EURUSD","GBPUSD","USDJPY"],"tenors":["1M","3M","6M","1Y"]}'::jsonb),
 ('BOUNDED_HISTORY','BLOCKED','LICENSE_REQUIRED','{"source":"LSEG_WMR","targetRowsPerPair":250}'::jsonb),
 ('SPOT_LINKAGE','BLOCKED','UPSTREAM_CURRENT_FORWARD_BLOCKED','{"alignment":"SAME_SOURCE_SAME_FIXING"}'::jsonb),
 ('POINTS_DERIVATION','BLOCKED','UPSTREAM_VERIFIED_SPOT_BLOCKED','{"formulaVersion":"FX_POINTS_V1"}'::jsonb),
 ('CURVE_ANALYTICS','BLOCKED','UPSTREAM_POINTS_HISTORY_BLOCKED','{"metrics":["3M_MINUS_1M","6M_MINUS_3M","1Y_MINUS_6M"]}'::jsonb),
 ('COVERAGE_REFRESH','READY',NULL,'{"scope":"FX_FORWARD_POINTS_ONLY"}'::jsonb)
) q(kind,status,blocker,payload)
ON CONFLICT(dedupe_key) DO UPDATE SET status=EXCLUDED.status,blocker=EXCLUDED.blocker,payload=EXCLUDED.payload,updated_at=now();

CREATE INDEX IF NOT EXISTS fx_forward_observations_instrument_date_idx ON fx_forward_observations(forward_instrument_id,observation_date DESC);
CREATE INDEX IF NOT EXISTS fx_forward_work_items_status_idx ON fx_forward_work_items(status,kind);
