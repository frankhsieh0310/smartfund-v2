// Timezone-aware date/eligibility math for market-close-sync. Pure functions, no DB, no network —
// everything here is unit-testable in isolation (see __tests__/marketTime.test.ts).
//
// The one rule this file exists to enforce: a candle is "today's close" for a given market only if
// its own timestamp, converted through THAT MARKET's IANA timezone, lands on the local date we are
// checking — never by trusting array position or assuming every symbol's candles line up 1:1.

import type { ExchangeCalendarJob } from "./types";

/** Converts a unix-seconds timestamp to a "YYYY-MM-DD" local date string in the given IANA timezone. */
export function localDateFromUnix(timestampUnix: number, timeZone: string): string {
  const d = new Date(timestampUnix * 1000);
  // en-CA locale formats as YYYY-MM-DD directly — avoids a manual Intl.DateTimeFormatPart reassembly.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** The current local date + time-of-day ("HH:MM", 24h) in the given IANA timezone, for a given instant. */
export function localNow(now: Date, timeZone: string): { date: string; time: string; weekday: number } {
  const date = localDateFromUnix(Math.floor(now.getTime() / 1000), timeZone);
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
  const time = timeFmt.format(now);
  // getDay() convention (0=Sun..6=Sat) computed from the local date string, not from `now` directly
  // (which is UTC) — a local date can be a different calendar day than UTC `now`.
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, time, weekday };
}

function minutesSinceMidnight(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isTradingDay(job: ExchangeCalendarJob, localDate: string): boolean {
  const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  if (!job.weekdays.includes(weekday)) return false;
  if (job.holidays.includes(localDate)) return false;
  return true;
}

function addLocalDays(localDate: string, deltaDays: number): string {
  // Pure calendar-date arithmetic in UTC-as-calendar (never through a timezone-sensitive Date
  // constructor) — localDate is already a plain YYYY-MM-DD, we only need to step whole days.
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** Is this `localDate` (for `job`'s market) definitely closed-and-past-stabilization-delay as of
 * `now`? A date strictly before `now`'s own local date is trivially closed (it's entirely in the
 * past). `now`'s own local date additionally needs the close+delay wall-clock check. */
function isDefinitelyClosed(job: ExchangeCalendarJob, localDate: string, now: Date): boolean {
  const { date: nowLocalDate, time: nowLocalTime } = localNow(now, job.timezone);
  if (localDate < nowLocalDate) return true;
  if (localDate > nowLocalDate) return false; // a future date can never be closed
  const closeMinutes = minutesSinceMidnight(job.regularSession.close) + job.stabilizationDelayMinutes;
  return minutesSinceMidnight(nowLocalTime) >= closeMinutes;
}

const DEFAULT_TRADING_DAY_LOOKBACK = 5;

/**
 * The target local trading date to sync for `job`, as of `now`: the MOST RECENT trading day that is
 * both (a) definitely closed+past-stabilization-delay and (b) not yet marked done by `isDoneForDate`.
 * Scans calendar days backward from `now`'s own local date (which is itself a candidate only once
 * it's closed — see isDefinitelyClosed), skipping non-trading days (weekends/holidays), for up to
 * `maxTradingDayLookback` actual trading days considered. Returns null if every trading day in that
 * window is either not yet closed or already done (the market is "caught up").
 *
 * This replaces the earlier, narrower "is *today* done cooking yet" check (which, past local
 * midnight in a market's own timezone, could report a market ineligible merely because tomorrow's
 * session hasn't closed yet — even though yesterday's real close was still sitting there unsynced).
 */
export function findEligibleTradeDate(
  job: ExchangeCalendarJob,
  now: Date,
  isDoneForDate: (localDate: string) => boolean,
  maxTradingDayLookback: number = DEFAULT_TRADING_DAY_LOOKBACK,
): { targetLocalDate: string } | null {
  const { date: nowLocalDate } = localNow(now, job.timezone);
  let tradingDaysSeen = 0;
  // Calendar-day cap well above maxTradingDayLookback so a long holiday cluster can't infinite-loop;
  // 3x the trading-day target is generous (covers even a 2-week holiday block around a 5-day lookback).
  const calendarDayCap = maxTradingDayLookback * 3 + 10;
  for (let back = 0; back <= calendarDayCap && tradingDaysSeen < maxTradingDayLookback; back++) {
    const candidate = addLocalDays(nowLocalDate, -back);
    if (!isTradingDay(job, candidate)) continue;
    tradingDaysSeen++;
    if (!isDefinitelyClosed(job, candidate, now)) continue; // today, not closed yet — not a candidate
    if (isDoneForDate(candidate)) continue; // already synced — keep scanning older days for a gap
    return { targetLocalDate: candidate };
  }
  return null;
}

/**
 * Of all the (timestamp, close) points Spark returned for one symbol, pick the one whose LOCAL date
 * (in `timeZone`) exactly equals `targetLocalDate`. Returns null if none match — this is the
 * SOURCE_MISSING case, never filled in by falling back to the nearest/last point.
 *
 * Second, defensive check (independent of the caller already having confirmed market eligibility):
 * if the matched point's local date equals `now`'s own local date AND `now`'s local wall-clock time
 * is still before close+stabilizationDelay, the point is rejected as a still-forming intraday bar
 * that merely happens to carry today's date stamp — never accepted as "today's close" early.
 */
export function pickClosedCandle(
  points: Array<{ timestampUnix: number; close: number | null }>,
  job: ExchangeCalendarJob,
  targetLocalDate: string,
  now: Date,
): { timestampUnix: number; close: number | null } | null {
  const match = points.find((point) => localDateFromUnix(point.timestampUnix, job.timezone) === targetLocalDate);
  if (!match) return null;
  const { date: nowLocalDate, time: nowLocalTime } = localNow(now, job.timezone);
  if (targetLocalDate === nowLocalDate) {
    const closeMinutes = minutesSinceMidnight(job.regularSession.close) + job.stabilizationDelayMinutes;
    if (minutesSinceMidnight(nowLocalTime) < closeMinutes) return null; // still intraday — reject
  }
  return match;
}
