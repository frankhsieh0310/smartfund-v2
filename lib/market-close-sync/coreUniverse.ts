// Task L: decides which ETFs belong in the daily sync's "core universe" — the subset actually worth
// re-checking every run, as opposed to the full is_active+data_source universe (which includes a long
// tail of delisted-in-practice, currency-counter, and barely-traded rows that would otherwise consume
// Spark requests and time-budget for no benefit). Pure, DB-free decision logic lives here; route.ts
// does the one aggregate SQL pass that feeds it.

/** Which etf_history column answers "did this ETF trade on this day" for a given Yahoo suffix.
 *
 * Default is "volume" (volume > 0). Live investigation this round (a 40-day sample across every
 * suffix in the universe) found volume is never literally NULL anywhere — but for a handful of
 * suffixes it is overwhelmingly a flat placeholder 0 rather than a real traded/untraded signal,
 * which is the same underlying "this market's volume field isn't trustworthy" problem the task
 * anticipated under the literal "mostly NULL" wording, just manifesting as zero instead of NULL:
 *   .VI (Vienna, supplemental-vienna):      619/7345  = 8.4% positive-volume rows
 *   .DU (Düsseldorf, germany-yahoo-daily):   79/3898  = 2.0% positive-volume rows
 *   .F  (Frankfurt, germany-yahoo-daily):  2254/4686  = 48.1% positive-volume rows (borderline, under
 *                                                        the 50% cutoff, included in the substitute)
 * Every other suffix sampled has a healthy (>50%, most far higher) positive-volume rate and uses the
 * default. Reported explicitly in the task's CORE_UNIVERSE_FILTER output per the instruction to note
 * which markets use the substitute. */
export type ActivityMeasure = "volume" | "close";

export const SUFFIX_ACTIVITY_MEASURE: Record<string, ActivityMeasure> = {
  ".VI": "close",
  ".DU": "close",
  ".F": "close",
};
export const DEFAULT_ACTIVITY_MEASURE: ActivityMeasure = "volume";

export function activityMeasureForDataSource(dataSource: string): ActivityMeasure {
  const dot = dataSource.lastIndexOf(".");
  if (dot === -1) return DEFAULT_ACTIVITY_MEASURE;
  return SUFFIX_ACTIVITY_MEASURE[dataSource.slice(dot)] ?? DEFAULT_ACTIVITY_MEASURE;
}

/** Hong Kong's alternate-currency trading counters (e.g. "02800-U.HK", "03010-R.HK") are a second
 * quote line for the SAME underlying product, not a separate thing this sync needs to track twice.
 * Excluded unconditionally, independent of the trading-activity test below — explicitly NOT a name-
 * keyword exclusion (no product name is inspected), just the HK-specific "-U"/"-R" counter-code
 * suffix immediately before ".HK". */
export function isHongKongCurrencyCounter(dataSource: string): boolean {
  return /-[ur]\.hk$/i.test(dataSource);
}

export const MIN_RECENT_TRADING_DAYS = 20;
export const MIN_ACTIVE_DAYS_ESTABLISHED = 15; // of the most recent 20 rows
export const MIN_ACTIVE_FRACTION_NEW_LISTING = 0.75; // of however many rows exist, when under 20

/** One of an ETF's most recent etf_history rows, pre-resolved to "did this day count as traded"
 * under whichever activityMeasure applies to its own data_source (see activityMeasureForDataSource —
 * never decided inside this function, so the caller's SQL/JS resolution is the single source of
 * truth and this stays a pure, trivially testable decision). */
export type RecentDay = { tradedPositive: boolean };

/**
 * Core-universe membership from an ETF's most recent trading-day rows, ordered most-recent-first.
 * - No history at all (0 rows): excluded — nothing establishes it's actually trading yet.
 * - >= 20 rows (an established listing): needs >= 15 of the most recent 20 to be active.
 * - < 20 rows (a new listing, not yet 20 trading days old): needs >= 75% of whatever rows exist.
 */
export function isCoreUniverseMember(recentDays: RecentDay[]): boolean {
  if (recentDays.length === 0) return false;
  if (recentDays.length >= MIN_RECENT_TRADING_DAYS) {
    const window = recentDays.slice(0, MIN_RECENT_TRADING_DAYS);
    const activeDays = window.filter((d) => d.tradedPositive).length;
    return activeDays >= MIN_ACTIVE_DAYS_ESTABLISHED;
  }
  const activeDays = recentDays.filter((d) => d.tradedPositive).length;
  return activeDays / recentDays.length >= MIN_ACTIVE_FRACTION_NEW_LISTING;
}

/** Same decision as isCoreUniverseMember, taking pre-aggregated counts instead of a materialized
 * array — the route's real SQL already caps daysAvailable at MIN_RECENT_TRADING_DAYS (its window
 * clause only ever looks at the most recent 20 rows per etf_id), so there is no "only the most
 * recent 20 of more rows count" case to re-derive here; daysAvailable IS already that count. */
export function isCoreUniverseMemberFromCounts(daysAvailable: number, activeDays: number): boolean {
  if (daysAvailable === 0) return false;
  if (daysAvailable >= MIN_RECENT_TRADING_DAYS) return activeDays >= MIN_ACTIVE_DAYS_ESTABLISHED;
  return activeDays / daysAvailable >= MIN_ACTIVE_FRACTION_NEW_LISTING;
}
