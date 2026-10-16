-- DRAFT, NOT EXECUTED. Needs user approval before running.
--
-- 24 rows in `etfs` (is_active=true) are confirmed, via cross-reference against TWSE/TPEx's own
-- official ETF registry (mopsfin.twse.com.tw/opendata/t187ap47_{L,O}.csv, fetched live 2026-10-16,
-- 427 official ETF codes total), to NOT be ETFs at all:
--   - 6 REITs (01001T/01002T/01004T/01007T/01009T/01010T -- Taiwan's 01xxxT numbering convention
--     for listed real-estate investment trusts, confirmed by name: Fubon/Cathay/O-Bank/King's Town
--     REITs)
--   - 17 beneficiary certificates on securities-company holdings (020000/020001/020012/020020/
--     020025/020028/020029/020030/020031/020033/020034/020036/020037/020038/020039/02001L/020041
--     -- all named directly after a securities company: Fubon/Yuanta/President/Uni-President/Mega)
--   - 1 ETN (020032.TW "元大綠能N" -- verified live on Yahoo奇摩: no NAV, no fund-type fields, the
--     "N" suffix is Taiwan's convention for an Exchange Traded Note, a debt instrument tracking an
--     index, structurally different from an ETF)
--
-- This is why these 24 (well, originally found as 8 in the "stale > 7 days" bucket during the
-- etf-returns-sync-tw investigation -- the other 16 were found by cross-checking the FULL 414-row
-- active TW-listed set against the official registry, not just the stale ones) never had Yahoo
-- fund-performance data and sat on 0 or null returns indefinitely: they were never funds to begin
-- with, so there was nothing wrong with the sync pipeline for them specifically.
--
-- Per user instruction: mark is_active=false, do NOT delete any row or any related data
-- (etf_performances, holdings, etc. all stay as historical record).

BEGIN;

UPDATE etfs SET is_active = false, updated_at = NOW()
WHERE code IN (
  '01001T.TW', '01002T.TW', '01004T.TW', '01007T.TW', '01009T.TW', '01010T.TW',
  '020000.TW', '020001.TWO', '020012.TW', '020020.TW', '020025.TWO', '020028.TW',
  '020029.TW', '020030.TW', '020031.TW', '020033.TWO', '020034.TW', '020036.TW',
  '020037.TW', '020038.TW', '020039.TW', '02001L.TW', '020032.TW', '020041.TWO'
)
RETURNING code, name;
-- Expected: exactly 24 rows returned.

COMMIT;
