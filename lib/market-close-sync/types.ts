// Shared types for the market-close-sync shadow pipeline. ETF-only. No price-table writes anywhere
// in this module tree — see app/api/cron/market-close-sync/route.ts for the read-only DB access and
// the run-log-only write path.

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
};

// SOURCE_MISSING split in two per task J: Spark can either omit the symbol entirely from its result
// array (genuinely has nothing for this ticker right now) or return the symbol with real candles
// that simply don't include a bar for the target date (NO_BAR_FOR_TARGET_DATE) — these have very
// different implications (a dead/delisted symbol vs. a transient same-day publication lag) and must
// not be collapsed into one bucket.
export type ShadowClassification = "NEW" | "CHANGED" | "SAME" | "SOURCE_MISSING" | "NO_BAR_FOR_TARGET_DATE" | "DB_NEWER";

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
