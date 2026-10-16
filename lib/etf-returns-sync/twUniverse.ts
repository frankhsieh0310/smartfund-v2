// Shared definition of "TW-eligible" for etf-returns-sync's two routes (the main sweep and the
// dedicated etf-returns-sync-tw cron): any active, recently-priced ETF whose own data_source ends in
// .TW/.TWO, OR whose bare code has a sibling row that does (the 58 duplicate-pair bare-code rows
// documented in app/api/cron/etf-returns-sync/route.ts -- the override-promoted population). Both
// routes must agree on this set byte-for-byte: the main sweep EXCLUDES it (so it only spends its
// budget on the much larger non-TW population) and the dedicated route INCLUDES exactly it (so every
// TW-listed ETF gets the full, undiluted 3.2s-paced budget instead of competing for scraps of a
// shared budget against ~16,000 non-TW ETFs it was previously drowned out by -- see the 2026-10-16
// writeup in etf-returns-sync-tw/route.ts for why this split exists).
export const TW_ELIGIBLE_SQL_CONDITION = `(
  bare.data_source ~ '\\.(TW|TWO)$'
  OR EXISTS (SELECT 1 FROM etfs suf WHERE suf.code = bare.code || '.TW' OR suf.code = bare.code || '.TWO')
)`;
