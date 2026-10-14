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

/** 2026-10-13 correction: the original version counted EVERY configured date as a gap for EVERY
 * candidate, with no concept of "this date was never a trading day" or "we already asked Yahoo and it
 * genuinely has nothing for this one". Confirmed live: 2026-10-09/10/11 (Fri/Sat/Sun -- Taiwan's 國慶日
 * fell on a Saturday, so the Friday became a bridge holiday) have ZERO Yahoo data for 0050.TW itself,
 * meaning the whole market was closed, not a data gap -- yet the old logic counted all 347 candidates
 * x all 3 of those dates as "missing" forever, since Yahoo will never produce a close for a day the
 * exchange never opened. `alreadyComplete` could never become true with those dates in the list, and
 * the temporary every-30-min cron (vercel.json) would have run indefinitely. Two independent filters
 * now apply before something counts as a real gap:
 *   1. filterTradingDates() -- the date itself must be a genuine trading day (below).
 *   2. confirmedNoData -- this exact (etfId, date) must not already be a confirmed "Yahoo has nothing
 *      for this one specific symbol on this trading day" result from a prior run (e.g. the fund simply
 *      didn't trade that day, or -- 00838B -- Yahoo has no data for the symbol at all, ever).
 */
export function computeMissingPairs(
  candidateEtfIds: string[],
  dates: string[],
  existingPairs: ReadonlySet<string>,
  confirmedNoData: ReadonlySet<string> = new Set(),
): CandidatePair[] {
  const missing: CandidatePair[] = [];
  for (const etfId of candidateEtfIds) {
    for (const date of dates) {
      const key = `${etfId}::${date}`;
      if (!existingPairs.has(key) && !confirmedNoData.has(key)) missing.push({ etfId, date });
    }
  }
  return missing;
}

/** Which of `dates` are genuine trading days, per the caller's own trading-day reference set (built
 * from 0050.TW's own Yahoo chart data -- if the single most heavily-traded TW ETF has no bar for a
 * date, the exchange simply wasn't open that day; this is a live, self-updating substitute for a
 * hardcoded holiday calendar, consistent with how the rest of this pipeline already trusts Yahoo as
 * its source of truth). A date absent from the reference set is dropped from the backfill target list
 * entirely -- never counted as a gap, never fetched, never blocks `alreadyComplete`. */
export function filterTradingDates(dates: readonly string[], tradingDays: ReadonlySet<string>): string[] {
  return dates.filter((d) => tradingDays.has(d));
}

/** Builds the trading-day reference set from the proxy symbol's raw chart points. A date counts as a
 * trading day iff Yahoo's response has A BAR for it (a timestamp entry) -- NOT iff that bar's `close`
 * happens to be non-null. Found 2026-10-14 (round-4 QA): Yahoo's own chart response for 0050.TW had a
 * genuine timestamp for 2026-10-13 (a confirmed real trading day) but with `close: null` for that one
 * bar -- a transient Yahoo-side gap, not evidence the market was closed. Filtering on `close != null`
 * wrongly excluded a real trading day from the whole backfill. Bar presence = market open; a null
 * close for one specific symbol is a separate, already-handled signal (computeConfirmedNoData below),
 * never a calendar fact. */
export function buildTradingDaySet(calendarPoints: readonly { dateKey: string; close: number | null }[]): Set<string> {
  return new Set(calendarPoints.map((p) => p.dateKey));
}

/** Of the dates actually requested for one symbol this run, which ones Yahoo's response had NO close
 * for at all. Since the caller only ever requests confirmed trading days (filterTradingDates already
 * ran), a date missing here means this ONE symbol didn't trade that day (or -- 00838B -- Yahoo has
 * nothing for the symbol whatsoever) -- a real, confirmed non-availability the caller should persist so
 * a later run never re-asks Yahoo the same question forever. */
export function computeConfirmedNoData(requestedDates: readonly string[], closes: ReadonlyMap<string, number>): string[] {
  return requestedDates.filter((d) => !closes.has(d));
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
