// TWSE/TPEx's own official market open/close calendar (the exact endpoint used manually on
// 2026-10-24 to check whether 2026-10-23 was a trading day -- it does NOT list 2026-10-23 as a
// holiday there, yet VERIFIED live via three separate date-explicit official endpoints (TWSE
// STOCK_DAY, STOCK_DAY_AVG_ALL, MI_INDEX; and TPEx's otc afterTrading endpoint) that neither
// exchange has ANY closing-price data for that date -- "stat":"ok","totalCount":0 on the TPEx
// side, a clean non-error response, not a fetch failure. Exact reason UNKNOWN (an ad-hoc closure
// such as a typhoon suspension is plausible -- those are announced separately and are NOT in this
// annual calendar -- but no suspension-announcement endpoint was found to confirm it). This module
// exists so that distinction (declared holiday vs. a real trading day with missing data) can be
// made automatically instead of re-investigated by hand every time: per the user's instruction,
// etf-history-gap-backfill's peer-max approach alone can't tell "every TWSE/TPEx ETF is behind
// because today is a holiday" apart from "every TWSE/TPEx ETF is behind because something broke
// market-wide" -- both look identical from inside one exchange. Cross-referencing this calendar
// is what tells them apart.
const HOLIDAY_SCHEDULE_URL = "https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json";

let cache: { dates: Set<string>; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour -- this calendar is published once a year and almost never changes intra-day

async function loadHolidayDates(): Promise<Set<string>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.dates;
  const res = await fetch(HOLIDAY_SCHEDULE_URL, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return cache?.dates ?? new Set();
  const body = (await res.json()) as { data?: Array<[string, string, string]> };
  const dates = new Set((body.data ?? []).map((row) => row[0]));
  cache = { dates, fetchedAt: Date.now() };
  return dates;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** True for a weekday that TWSE's own published calendar does NOT list as a holiday. Does not
 * (cannot) know about an ad-hoc same-week closure announced outside this annual calendar -- see
 * module comment above. */
export async function isTwseTradingDay(date: Date): Promise<boolean> {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const holidays = await loadHolidayDates();
  return !holidays.has(isoDate(date));
}

/** The most recent date that TWSE's own calendar says should have traded, strictly before `from`. */
export async function latestScheduledTradingDay(from = new Date()): Promise<Date> {
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  for (let i = 0; i < 14; i++) {
    if (await isTwseTradingDay(cursor)) return cursor;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return cursor; // fallback -- should not happen inside 14 days
}
