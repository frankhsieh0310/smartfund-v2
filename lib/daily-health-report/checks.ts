// Pure, DB-query-injected health checks for the daily report (no Next.js/Prisma import so this stays
// unit-testable with a mock QueryFn, same convention as every other pipeline this session).
export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type PipelineHealth = {
  jobId: string;
  hasRunInLast24h: boolean;
  errorCount24h: number;
  writeErrorCount24h: number;
  lastStatus: string | null;
  lastError: string | null;
  anomaly: boolean;
  anomalyReasons: string[];
};

// Checks production_scheduler_runs for a given job_id over the last 24h. A pipeline with ZERO runs in
// the window is itself an anomaly (the schedule expects at least one run per day for all six jobs this
// covers) -- never silently treated as "fine because nothing to report".
export async function checkPipelineRunLog(query: QueryFn, jobId: string): Promise<PipelineHealth> {
  const rows = await query(
    `SELECT status, error, details->>'write_error_count' AS write_error_count, started_at
       FROM production_scheduler_runs
      WHERE job_id = $1 AND started_at > now() - interval '24 hours'
      ORDER BY started_at DESC`,
    [jobId],
  );

  const errorCount24h = rows.filter((r) => r.error != null).length;
  const writeErrorCount24h = rows.reduce((sum, r) => sum + (Number(r.write_error_count) || 0), 0);
  const last = rows[0] ?? null;

  const anomalyReasons: string[] = [];
  if (rows.length === 0) anomalyReasons.push("NO_RUN_IN_LAST_24H");
  if (errorCount24h > 0) anomalyReasons.push(`ERROR_COUNT_${errorCount24h}`);
  if (writeErrorCount24h > 0) anomalyReasons.push(`WRITE_ERROR_COUNT_${writeErrorCount24h}`);

  return {
    jobId,
    hasRunInLast24h: rows.length > 0,
    errorCount24h,
    writeErrorCount24h,
    lastStatus: last?.status ?? null,
    lastError: last?.error ?? null,
    anomaly: anomalyReasons.length > 0,
    anomalyReasons,
  };
}

export type DataSourceGapResult = {
  nullCount: number;
  codes: string[]; // up to 10, for display
  knownCodes: string[]; // already-documented gaps (e.g. a suspected-delisted symbol) -- never re-raised as a fresh anomaly
  newCodes: string[]; // anything NOT already documented -- these alone drive `anomaly`
  anomaly: boolean;
};

// 2026-10-13: 33 TPEx ETFs were found with etfs.data_source = NULL (silently excluded from
// market-close-sync's core universe -- see lib/market-close-sync/coreUniverse.ts). 32 were backfilled;
// 00838B could not be (Yahoo has no data for 00838B.TWO at all, "No data found, symbol may be
// delisted"). Listed here so it surfaces every day as a known, already-investigated data point
// ("known/suspected delisted") rather than a fresh warning that looks identical to a brand-new gap.
export const KNOWN_DATA_SOURCE_GAPS: ReadonlySet<string> = new Set(["00838B"]);

// is_active TWSE/TPEx ETFs missing a data_source entirely fall out of market-close-sync's core
// universe without ANY error, log line, or alert (confirmed live 2026-10-13 -- this is exactly how 33
// funds went unnoticed for days). This check exists so a NEW gap (as opposed to the one already
// known and backfilled) is never silent again.
export async function checkEtfDataSourceGap(query: QueryFn): Promise<DataSourceGapResult> {
  const rows = await query(
    `SELECT code FROM etfs WHERE is_active = true AND exchange IN ('TWSE','TPEx') AND data_source IS NULL ORDER BY code`,
    [],
  );
  const allCodes: string[] = rows.map((r) => r.code);
  const knownCodes = allCodes.filter((c) => KNOWN_DATA_SOURCE_GAPS.has(c));
  const newCodes = allCodes.filter((c) => !KNOWN_DATA_SOURCE_GAPS.has(c));
  return { nullCount: allCodes.length, codes: allCodes.slice(0, 10), knownCodes, newCodes, anomaly: newCodes.length > 0 };
}

export type DataFreshnessResult = {
  label: string;
  latestDate: string | null;
  staleDays: number | null;
  anomaly: boolean;
  anomalyReason: string | null;
};

// Generic "is this table's latest date reasonably recent" check. maxStaleDays accounts for
// weekends/holidays loosely (not a full trading-calendar lookup) -- documented limitation, not a bug.
export function evaluateFreshness(label: string, latestDateIso: string | null, maxStaleDays: number): DataFreshnessResult {
  if (!latestDateIso) {
    return { label, latestDate: null, staleDays: null, anomaly: true, anomalyReason: "NO_DATA" };
  }
  const latest = new Date(latestDateIso);
  const staleDays = Math.floor((Date.now() - latest.getTime()) / 86400000);
  const anomaly = staleDays > maxStaleDays;
  return { label, latestDate: latestDateIso, staleDays, anomaly: anomaly ? true : false, anomalyReason: anomaly ? `STALE_${staleDays}D` : null };
}

export type YahooTwReturnSample = {
  code: string;
  ourReturn1y: number | null;
  yahooTwReturn1y: number | null; // null when the fetch itself failed/was rate-limited
  fetchFailed: boolean;
  /** The trading-day basis our stored return_1y was actually computed as of (etf_performances'
   * latest row date for this ETF), and the basis date Yahoo奇摩's own page discloses for the value
   * just fetched. When these differ, a diff beyond MISMATCH_THRESHOLD_PCT_POINTS is NOT a parser
   * bug -- it's this health-report run (00:30 UTC) landing before etf-returns-sync's own daily
   * refresh for that specific ETF has completed yet, comparing yesterday's stored figure against
   * today's live Yahoo page. VERIFIED live 2026-10-16: 00980A (inception 2025-04-21, still young and
   * concentrated enough that its trailing-1Y return swings 15-20pp day to day on its own, confirmed
   * across 10 consecutive real Yahoo-sourced daily values) flagged a 16.46pp "mismatch" at 00:30 UTC
   * purely because our stored value was still 10/11's basis; by the time etf-returns-sync's own run
   * caught up hours later, etfs.return_1y matched Yahoo exactly (90.94 both sides). */
  ourBasisDate: string | null;
  yahooAsOfDate: string | null;
};

export type YahooTwReturnCheckResult = {
  samples: YahooTwReturnSample[];
  /** Any sample whose |diff| exceeds this, or whose fetch failed, is flagged. */
  mismatches: Array<YahooTwReturnSample & { diff: number | null }>;
  anomaly: boolean;
};

// Per docs/specs/yahoo-return-discrepancy.md: our stored return_1y (Yahoo global API) and Yahoo奇摩's
// own displayed value are known to NOT always agree exactly (different basis date, NAV- vs
// price-based calculation) -- a few points of drift is expected, not an anomaly. This threshold is
// for catching a REAL regression (e.g. the parser breaking after a Yahoo奇摩 page redesign, or a
// figure suddenly off by tens of points), not for chasing exact equality with a source that this
// project's own investigation found is never going to match exactly.
const MISMATCH_THRESHOLD_PCT_POINTS = 15;
// A diff this large is never explained by a one-day staleness gap, even for the most volatile young
// ETF in this universe (see the 00980A write-up above) -- always flag it regardless of basis date.
const HARD_CEILING_PCT_POINTS = 40;

export function evaluateYahooTwReturnConsistency(samples: YahooTwReturnSample[]): YahooTwReturnCheckResult {
  const mismatches = samples
    .map((s) => ({ ...s, diff: s.ourReturn1y != null && s.yahooTwReturn1y != null ? Math.abs(s.ourReturn1y - s.yahooTwReturn1y) : null }))
    .filter((s) => {
      if (s.fetchFailed || s.diff === null) return true;
      if (s.diff > HARD_CEILING_PCT_POINTS) return true;
      if (s.diff <= MISMATCH_THRESHOLD_PCT_POINTS) return false;
      // Between the two thresholds: only an anomaly if both sides are actually quoting the same
      // trading day -- otherwise it's staleness, not a data bug.
      return s.ourBasisDate !== null && s.yahooAsOfDate !== null && s.ourBasisDate === s.yahooAsOfDate;
    });
  return { samples, mismatches, anomaly: mismatches.length > 0 };
}
