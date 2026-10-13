-- Yahoo US-mutual-fund Morningstar structured fields (additive, nullable — no data loss).
-- funds.morningstar (INT 1-5) already exists and is treated as the OVERALL rating; this migration
-- adds the risk rating, Morningstar category, 3Y category rank, and provenance so a Yahoo
-- enrichment can populate them without overwriting other providers' values.
--
-- NOTE: Morningstar fields are FUND-ONLY. No ETF Morningstar columns are created.

ALTER TABLE funds ADD COLUMN IF NOT EXISTS morningstar_risk             integer;    -- 1..5 (1=Low .. 5=High)
ALTER TABLE funds ADD COLUMN IF NOT EXISTS morningstar_category        text;        -- e.g. "Large Blend", "Intermediate Core Bond"
ALTER TABLE funds ADD COLUMN IF NOT EXISTS morningstar_category_rank_3y integer;    -- percentile 1..100 (lower = better)
ALTER TABLE funds ADD COLUMN IF NOT EXISTS morningstar_source          text;        -- e.g. "YAHOO_QUOTE_SUMMARY"
ALTER TABLE funds ADD COLUMN IF NOT EXISTS morningstar_updated_at      timestamptz;

COMMENT ON COLUMN funds.morningstar IS 'Morningstar overall star rating 1-5 (provider-agnostic; see morningstar_source)';
COMMENT ON COLUMN funds.morningstar_risk IS 'Morningstar risk rating 1-5 (1=Low..5=High)';
COMMENT ON COLUMN funds.morningstar_category IS 'Morningstar category label';
COMMENT ON COLUMN funds.morningstar_category_rank_3y IS 'Morningstar 3-year rank-in-category percentile (1..100, lower better)';
