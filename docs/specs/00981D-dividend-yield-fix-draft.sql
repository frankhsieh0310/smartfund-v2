-- DRAFT -- NOT executed. Needs approval (listed in the final deploy-ask message).
-- Root cause (confirmed this round): 00981D exists as two DB rows -- the bare `00981D` (the one
-- actually displayed/ranked) has dividend_yield=NULL; `00981D.TWO` has a real Yahoo-sourced 7.34%.
-- The ranking API's own `code !~ '\.'` filter excludes the .TWO row regardless, so backfilling
-- the bare row is the only fix that makes this ETF's yield show up anywhere.
-- Conditioned on dividend_yield still being NULL, so it's a no-op if something else already fixed it.

UPDATE etfs
   SET dividend_yield = (SELECT dividend_yield FROM etfs WHERE code = '00981D.TWO' LIMIT 1),
       updated_at = now()
 WHERE code = '00981D' AND dividend_yield IS NULL;
