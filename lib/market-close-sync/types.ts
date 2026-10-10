// Shared types for the market-close-sync pipeline. ETF-only. Task P adds an opt-in write path
// (lib/market-close-sync/priceWriter.ts, gated by MARKET_CLOSE_SYNC_WRITE — off by default, shadow
// mode unchanged) — see app/api/cron/market-close-sync/route.ts for the gate and the write call site.

export type ExchangeCalendarJob = {
  id: string;
  market: string;
  exchange: string;
  exchanges: string[];
  country: string;
  timezone: string; // IANA zone, e.g. "Asia/Taipei"
  regularSession: { open: string; close: string }; // "HH:MM", local to `timezone`
  stabilizationDelayMinutes: number;
  weekdays: number[]; // 0=Sunday..6=Saturday, Date#getDay() convention
  holidays: string[]; // "YYYY-MM-DD", local calendar dates
  schedulerEnabled: boolean;
};

export type ExchangeCalendarRegistry = {
  jobs: ExchangeCalendarJob[];
};

// A market this invocation has determined is "closed, past its stabilization delay, and not yet
// fully synced for `targetLocalDate`" — a genuine candidate to process this run.
export type EligibleMarket = {
  job: ExchangeCalendarJob;
  targetLocalDate: string; // "YYYY-MM-DD", the local trading date we expect today's close for
};

export type SparkCandle = {
  symbol: string;
  // Every (timestamp, close) pair Spark returned for this symbol, unfiltered — date alignment and
  // intraday rejection happen one level up, against the market's own timezone, never by array index.
  points: Array<{ timestampUnix: number; close: number | null }>;
  // Task M: Spark's own per-symbol meta.regularMarketTime/regularMarketPrice — the live/latest quote,
  // independent of the daily bar array above. null when Spark's response carried no meta for this
  // symbol. Consumed by lib/market-close-sync/priceSource.ts's QUOTE_AFTER_CLOSE rule.
  regularMarketTimeUnix: number | null;
  regularMarketPrice: number | null;
  // Task P: Yahoo's own previous-session close (Spark meta.chartPreviousClose) — an independent
  // second opinion, from Yahoo itself, for whether a big move away from the ETF's own last DB close
  // is a real data problem or just a stale DB catching up. null when Spark's meta omitted it.
  chartPreviousClose: number | null;
};

// SOURCE_MISSING split in two per task J: Spark can either omit the symbol entirely from its result
// array (genuinely has nothing for this ticker right now) or return the symbol with real candles
// that simply don't include a bar for the target date (NO_BAR_FOR_TARGET_DATE) — these have very
// different implications (a dead/delisted symbol vs. a transient same-day publication lag) and must
// not be collapsed into one bucket.
// Task N: NO_TRADE_ON_TARGET is decided entirely by priceSource.ts, before classify() is even
// called — once "now" is past the target date's close+delay and the live quote's own local date is
// confirmed EARLIER than the target date, the market simply didn't trade that day. classify() never
// sees this case (there is no DB-vs-source price to compare — it's a statement about market
// activity, not price), so it is never one of classify()'s own return values.
// Task O: UNIT_MISMATCH/PRICE_JUMP_REVIEW are decided by priceSanity.ts, after a price has already
// resolved (BAR or QUOTE_FINAL) but before classify() would otherwise bucket it as NEW/CHANGED/SAME/
// DB_NEWER — a resolved price that fails the sanity check against the ETF's own last known DB close
// is diverted into one of these two record-only review buckets instead, so it never inflates the
// normal classification counts with data that's actually suspect.
// Task P: when a resolved price fails the Task O sanity check against the ETF's OWN last DB close
// (PRICE_JUMP_REVIEW territory) but Yahoo's own previous-session close (chartPreviousClose) agrees
// with the new price within the same ±50% band, the "jump" is just the DB catching up after a stale
// gap, not a real data problem — reclassified DB_DISCONTINUITY, which (unlike PRICE_JUMP_REVIEW) IS
// written when the write switch is on. UNIT_MISMATCH never gets this second opinion — it stays
// unwritten unconditionally, per task scope.
export type ShadowClassification = "NEW" | "CHANGED" | "SAME" | "SOURCE_MISSING" | "NO_BAR_FOR_TARGET_DATE" | "DB_NEWER" | "NO_TRADE_ON_TARGET" | "UNIT_MISMATCH" | "PRICE_JUMP_REVIEW" | "DB_DISCONTINUITY";

export type ShadowRow = {
  etfId: string;
  symbol: string;
  classification: ShadowClassification;
  dbDate: string | null;
  dbClose: number | null;
  sparkDate: string | null;
  sparkClose: number | null;
};

export type EtfCandidate = {
  id: string;
  code: string;
  exchange: string;
  dataSource: string; // Yahoo symbol
  priceUpdatedAt: string | null; // ISO date, from etfs.price_updated_at
  latestPrice: number | null;
};
