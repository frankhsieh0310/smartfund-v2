-- EXECUTED (user-approved, prior round). VERIFIED 2026-10-16 via live SELECT: both 00981D and
-- 00981D.TWO now show dividend_yield=0.0734. lib/data-platform/web/etfService.ts's
-- DEDUP_BACKFILL_PENDING set still listed "00981D" as pending after this ran -- that was stale
-- and has been corrected in the same commit as this note.
-- Root cause (confirmed this round): 00981D exists as two DB rows -- the bare `00981D` (the one
-- actually displayed/ranked) has dividend_yield=NULL; `00981D.TWO` has a real Yahoo-sourced 7.34%.
-- The ranking API's own `code !~ '\.'` filter excludes the .TWO row regardless, so backfilling
-- the bare row is the only fix that makes this ETF's yield show up anywhere.
-- Conditioned on dividend_yield still being NULL, so it's a no-op if something else already fixed it.

UPDATE etfs
   SET dividend_yield = (SELECT dividend_yield FROM etfs WHERE code = '00981D.TWO' LIMIT 1),
       updated_at = now()
 WHERE code = '00981D' AND dividend_yield IS NULL;
