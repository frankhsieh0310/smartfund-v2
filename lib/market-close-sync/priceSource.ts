// Task N: decides which price represents "today's close" for a target local trading day, in
// priority order — never interpolated or guessed beyond these sources:
//   1. BAR — the daily candle's own close for the target date, once Yahoo has actually published it
//      (unchanged from existing pickClosedCandle/classify() plumbing).
//   2. QUOTE_FINAL — Yahoo's live/latest quote (Spark's meta.regularMarketTime/regularMarketPrice),
//      once "now" is past the target date's own close+delay AND the quote's own local date equals
//      the target date. Task M's original rule additionally required the QUOTE's own timestamp to be
//      later than close — Task N drops that: the quote's timestamp is used ONLY to confirm which
//      calendar day it belongs to, never compared against a clock boundary itself. The real
//      decision of "has the close been decided yet" is now the SAME close+delay test used
//      everywhere else in this feature (isDefinitelyClosed), not a bespoke one — see
//      marketTime.test.ts's "最後成交14:30" fixture: a 14:30 last-trade quote is adopted once the
//      invocation's own clock is past close+delay, and withheld while it isn't, regardless of how
//      early 14:30 itself looks.
//   3. NO_TRADE_ON_TARGET — once "now" is past the target date's own close+delay, if the quote's own
//      local date is confirmed EARLIER than the target date (the most recent trade Yahoo knows about
//      predates the day we're asking about), the market simply didn't trade that day. This is a
//      genuinely final classification — see completionState.ts — never re-checked again, because no
//      future re-check can make a day that already closed start having traded.
//   4. Anything else (no quote at all, or a quote dated AFTER the target — tells us nothing about
//      the target day specifically) stays unresolved: the caller feeds classify() sparkDate=null/
//      sparkClose=null exactly as before, landing in the existing NO_BAR_FOR_TARGET_DATE provisional
//      state with its own 6h confirmation window — never backfilled from anything else.

import type { ExchangeCalendarJob } from "./types";

export type PriceSource = "BAR" | "QUOTE_FINAL";

export type PriceResolution =
  | { kind: "RESOLVED"; source: PriceSource; price: number }
  | { kind: "NO_TRADE_ON_TARGET" }
  | { kind: "UNRESOLVED" };

export function resolvePrice(input: {
  job: ExchangeCalendarJob;
  targetLocalDate: string;
  now: Date;
  barClose: number | null; // from the daily candle (pickClosedCandle), if Yahoo has published one
  quoteRegularMarketTimeUnix: number | null; // Spark meta.regularMarketTime
  quoteRegularMarketPrice: number | null; // Spark meta.regularMarketPrice
  localDateFromUnix: (timestampUnix: number, timeZone: string) => string;
  isDefinitelyClosed: (job: ExchangeCalendarJob, localDate: string, now: Date) => boolean;
}): PriceResolution {
  if (input.barClose != null) return { kind: "RESOLVED", source: "BAR", price: input.barClose };

  // Rule 2/3 both require the target date's close+delay to have genuinely passed as of "now" —
  // before that, even a same-day quote is still potentially intraday and must not be adopted or
  // used to declare "no trade" (rule 4's catch-all: stays unresolved).
  if (!input.isDefinitelyClosed(input.job, input.targetLocalDate, input.now)) {
    return { kind: "UNRESOLVED" };
  }

  if (input.quoteRegularMarketTimeUnix == null || input.quoteRegularMarketPrice == null) {
    return { kind: "UNRESOLVED" };
  }

  const quoteLocalDate = input.localDateFromUnix(input.quoteRegularMarketTimeUnix, input.job.timezone);
  if (quoteLocalDate === input.targetLocalDate) {
    return { kind: "RESOLVED", source: "QUOTE_FINAL", price: input.quoteRegularMarketPrice };
  }
  if (quoteLocalDate < input.targetLocalDate) {
    return { kind: "NO_TRADE_ON_TARGET" };
  }
  // quoteLocalDate > targetLocalDate: the latest quote is for a LATER day than the one we're asking
  // about (e.g. re-checking an older date after trading has since moved on) — it says nothing about
  // whether the target day itself traded, so this falls through to rule 4, unresolved.
  return { kind: "UNRESOLVED" };
}
