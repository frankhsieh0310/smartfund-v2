-- Additive only (new nullable columns on an existing table) -- pre-approved per CLAUDE.md's dev
-- workflow rule ("新建資料表預先核准...只能新增表、欄位、索引"). No RLS/REVOKE needed: these are new
-- columns on an existing table, inheriting its existing RLS policy, not a new table.
--
-- Backs item 2 (債券反查) of the delivery checklist: the real iShares holdings CSV
-- (lib/cloud-ingestion/globalEtfHoldings.ts's source feed) genuinely has "Coupon (%)" and "Maturity"
-- columns (VERIFIED live 2026-10-16 against https://www.ishares.com/us/products/338251/.../latest-
-- holdings.csv), but the ingestion pipeline never captured either into `holdings`. Adding the columns
-- here; lib/cloud-ingestion/globalEtfHoldings.ts is updated in the same round to populate them going
-- forward via this table's EXISTING periodic ingestion job -- no separate backfill triggered by this
-- migration. Existing ~3M rows stay NULL here until that job's next normal pass touches each ETF.
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS coupon_rate numeric(10,4);
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS maturity_date date;
