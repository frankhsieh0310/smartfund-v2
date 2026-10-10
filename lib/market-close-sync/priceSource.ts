// Task M: decides which price represents "today's close" for a target local trading day, in
// priority order — never interpolated or guessed beyond these two sources:
//   1. BAR — the daily candle's own close for the target date, once Yahoo has actually published it
//      (unchanged from existing pickClosedCandle/classify() plumbing).
//   2. QUOTE_AFTER_CLOSE — Yahoo's live/latest quote (Spark's meta.regularMarketTime /
//      meta.regularMarketPrice), ONLY when its own timestamp's local date equals the target date AND
//      its local time-of-day is later than the market's closing-price-determination time. This
//      covers the real, user-reported case: Yahoo's own daily-bar aggregation has a same-day
//      publication lag (already documented in Task K's NO_BAR_FOR_TARGET_DATE investigation), but
//      its live quote already reflects a price captured after the day's closing price was decided.
//   3. Neither resolves -> stays unresolved. The caller feeds classify() sparkDate=null/sparkClose=
//      null exactly as before, landing in the existing NO_BAR_FOR_TARGET_DATE provisional state with
//      its own 6h confirmation window — never backfilled from anything else.

import type { ExchangeCalendarJob } from "./types";

// Live, real-world evidence (2026-10-09/10 session) that the shared stock-pipeline's session-close
// times in config/production-yahoo-daily-jobs.json (reused read-only, per task scope — this feature
// never edits that file) are not always the right boundary for "when is an ETF's closing price
// determined":
//
//   - Hong Kong (job close "16:10", the full session including HKEX's Closing Auction Session):
//     HKEX's own documented design randomizes the CAS's actual end between 16:08 and 16:10
//     specifically so it can't be gamed — any quote captured inside that window is already that
//     day's genuine closing print. Confirmed live: 2800.HK's regularMarketTime landed at 16:08:06
//     HKT, strictly before the nominal "16:10" field, yet its price (24.84) is exactly what the
//     user independently saw as that day's close on Yahoo's own page. The boundary that actually
//     matters for "has the close been decided yet" is when continuous trading ends: 16:00.
//   - Germany (job close "22:00"): Xetra's own regular ETF trading session runs 09:00-17:30
//     CET/CEST. Confirmed live: EUNL.DE's regularMarketTime (17:35:55 Berlin) is the genuine
//     post-close quote matching the user's own Yahoo-page observation (131.64) — nowhere near
//     22:00. The shared config's "22:00" appears tuned for a different (floor/extended-hours)
//     session this feature has no reason to depend on.
//
// Every other market this feature covers checked out live, consistent with its own
// job.regularSession.close with no override needed: UK close "16:35" vs CSPX.L's 19:00:59 quote,
// and France close "17:35" vs CW8.PA's 17:35:06 quote (a genuine 6-second margin, not a coincidence
// of truncation — see secondsSinceLocalMidnight below, which never truncates to minute precision for
// exactly this reason).
export const CLOSE_TIME_OVERRIDE: Record<string, string> = {
  "hong-kong-yahoo-daily": "16:00",
  "germany-yahoo-daily": "17:30",
};

function minutesSinceMidnight(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function closingDeterminationTimeFor(job: ExchangeCalendarJob): string {
  return CLOSE_TIME_OVERRIDE[job.id] ?? job.regularSession.close;
}

/** Seconds since local midnight for a unix-seconds timestamp, in the given IANA timezone. Full
 * second precision on purpose — truncating to "HH:MM" would silently treat France's real 6-second
 * after-close margin (CW8.PA: 17:35:06 vs close "17:35:00") as a tie. */
function secondsSinceLocalMidnight(timestampUnix: number, timeZone: string): number {
  const d = new Date(timestampUnix * 1000);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return get("hour") * 3600 + get("minute") * 60 + get("second");
}

export type PriceSource = "BAR" | "QUOTE_AFTER_CLOSE";
export type ResolvedPrice = { source: PriceSource; price: number };

export function resolvePrice(input: {
  job: ExchangeCalendarJob;
  targetLocalDate: string;
  barClose: number | null; // from the daily candle (pickClosedCandle), if Yahoo has published one
  quoteRegularMarketTimeUnix: number | null; // Spark meta.regularMarketTime
  quoteRegularMarketPrice: number | null; // Spark meta.regularMarketPrice
  localDateFromUnix: (timestampUnix: number, timeZone: string) => string;
}): ResolvedPrice | null {
  if (input.barClose != null) return { source: "BAR", price: input.barClose };

  if (input.quoteRegularMarketTimeUnix != null && input.quoteRegularMarketPrice != null) {
    const quoteLocalDate = input.localDateFromUnix(input.quoteRegularMarketTimeUnix, input.job.timezone);
    if (quoteLocalDate === input.targetLocalDate) {
      const quoteSeconds = secondsSinceLocalMidnight(input.quoteRegularMarketTimeUnix, input.job.timezone);
      const closeSeconds = minutesSinceMidnight(closingDeterminationTimeFor(input.job)) * 60;
      if (quoteSeconds > closeSeconds) {
        return { source: "QUOTE_AFTER_CLOSE", price: input.quoteRegularMarketPrice };
      }
    }
  }
  return null;
}
