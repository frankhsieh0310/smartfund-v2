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

/**
 * Is `job`'s market closed-and-past-its-stabilization-delay as of `now`, for `now`'s own local
 * trading date? Returns the target local date to sync if so, else null (either not a trading day,
 * or still before close+delay today).
 *
 * Deliberately does NOT look backward for a previous trading day the caller might have missed — the
 * checkpoint (stored by the route, not this module) is what carries forward "last date actually
 * synced"; this function only answers "is *today* done cooking yet".
 */
export function marketCloseEligibility(job: ExchangeCalendarJob, now: Date): { targetLocalDate: string } | null {
  const { date, time, weekday } = localNow(now, job.timezone);
  if (!job.weekdays.includes(weekday)) return null;
  if (job.holidays.includes(date)) return null;
  const closeMinutes = minutesSinceMidnight(job.regularSession.close) + job.stabilizationDelayMinutes;
  const nowMinutes = minutesSinceMidnight(time);
  if (nowMinutes < closeMinutes) return null;
  return { targetLocalDate: date };
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
