// One-time historical gap-fill, gated by MARKET_CLOSE_SYNC_BACKFILL_DATES (comma-separated YYYY-MM-DD).
// Root cause this repairs: 33 TPEx ETFs had etfs.data_source = NULL (an external bulk-import gap, not
// a market-close-sync bug -- see the 2026-10-13 data_source backfill), which silently excluded them
// from computeCoreUniverse() and therefore from the daily gap-repair check too. Fixing data_source
// lets the regular daily sync self-heal going forward, but the daily sync's own gap-repair only ever
// re-opens the SINGLE most recent lastDoneDate, never a whole historical date range -- so the
// 2026-10-07..10-13 gap these 33 funds accumulated needs this separate, explicit, one-time pass.
//
// Official-data note: TWSE's MI_INDEX API accepts an arbitrary historical `date` param and was
// confirmed working live this investigation. TPEx's equivalent page-driven endpoint
// (www/zh-tw/afterTrading/otc) could NOT be reproduced from a plain server-side fetch after repeated
// attempts (cookie-primed curl included) -- it returns 200 with an empty result set rather than a
// 401/403/429, so nothing here was blocked; the real browser session evidently carries some request
// shape this never matched. Substitute: Yahoo's own historical chart API (the SAME provider the daily
// sync already trusts for live quotes), queried per data_source symbol across the requested date
// range -- confirmed this session, for every sampled code, to match official TWSE/TPEx closes exactly.
export function parseBackfillDates(envValue: string | undefined): string[] {
  if (!envValue) return [];
  const dates = envValue.split(",").map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  return [...new Set(dates)].sort();
}

export type CandidatePair = { etfId: string; date: string };

/** Which (etfId, date) combinations, among all candidate ETFs x requested dates, are NOT already
 * present in etf_history -- the only ones this pass may write. `existingPairs` is a set of
 * "etfId::date" keys, already queried from the real DB. */
export function computeMissingPairs(candidateEtfIds: string[], dates: string[], existingPairs: ReadonlySet<string>): CandidatePair[] {
  const missing: CandidatePair[] = [];
  for (const etfId of candidateEtfIds) {
    for (const date of dates) {
      if (!existingPairs.has(`${etfId}::${date}`)) missing.push({ etfId, date });
    }
  }
  return missing;
}

export type YahooChartPoint = { dateKey: string; close: number | null };

/** Extracts a date->close map from a Yahoo chart API result, keyed by calendar date (already
 * resolved to the exchange's own local date by the caller -- this function does no timezone work,
 * it only picks out the requested dates from whatever points the caller hands it). Only requested
 * dates are returned, and only when the point's close isn't null (Yahoo returns a timestamp with a
 * null close for a genuine no-trade day -- never backfilled as if it were a real price). */
export function extractRequestedCloses(points: YahooChartPoint[], requestedDates: readonly string[]): Map<string, number> {
  const wanted = new Set(requestedDates);
  const result = new Map<string, number>();
  for (const p of points) {
    if (p.close != null && wanted.has(p.dateKey)) result.set(p.dateKey, p.close);
  }
  return result;
}
