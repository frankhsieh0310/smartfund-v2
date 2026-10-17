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

export function evaluateYahooTwReturnConsistency(samples: YahooTwReturnSample[]): YahooTwReturnCheckResult {
  const mismatches = samples
    .map((s) => ({ ...s, diff: s.ourReturn1y != null && s.yahooTwReturn1y != null ? Math.abs(s.ourReturn1y - s.yahooTwReturn1y) : null }))
    .filter((s) => s.fetchFailed || s.diff === null || s.diff > MISMATCH_THRESHOLD_PCT_POINTS);
  return { samples, mismatches, anomaly: mismatches.length > 0 };
}

export type FredCommoditySample = {
  label: "WTI_CRUDE" | "NATURAL_GAS";
  ourSymbol: string; // our Yahoo root's symbol, e.g. "CL=F"
  ourDate: string | null;
  ourClose: number | null;
  fredSeriesId: string;
  fredDate: string | null;
  fredValue: number | null;
  fetchFailed: boolean;
};
export type FredCommodityCheckResult = {
  samples: FredCommoditySample[];
  mismatches: Array<FredCommoditySample & { diffPct: number | null }>;
  anomaly: boolean;
};

// Weekend list item 6: daily cross-check of our Yahoo-sourced WTI/Natural Gas closes against FRED's
// own published spot series (DCOILWTICO = WTI Cushing OK spot, DHHNGSP = Henry Hub spot). These are
// NOT the same instrument as our Yahoo CL=F/NG=F (front-month CONTINUOUS FUTURES, not cash spot), so
// some everyday basis/contango spread is normal and expected -- this is not meant to chase exact
// equality. VERIFIED live 2026-10-14 sample: WTI futures vs FRED spot diverged ~7.2% (95.09 vs
// 101.91), natural gas ~0.7% (3.198 vs 3.22) -- thresholds below are set above that observed normal
// spread so this only fires on a genuinely abnormal divergence (a stale/broken feed on either side,
// or a real market dislocation worth a human look), not routine futures-vs-spot basis.
const FRED_MISMATCH_THRESHOLD_PCT = { WTI_CRUDE: 12, NATURAL_GAS: 15 } as const;

export function evaluateFredCommodityConsistency(samples: FredCommoditySample[]): FredCommodityCheckResult {
  const mismatches = samples
    .map((s) => ({
      ...s,
      diffPct: s.ourClose != null && s.fredValue != null && s.fredValue !== 0
        ? Math.abs((s.ourClose - s.fredValue) / s.fredValue) * 100
        : null,
    }))
    .filter((s) => s.fetchFailed || s.diffPct === null || s.diffPct > FRED_MISMATCH_THRESHOLD_PCT[s.label]);
  return { samples, mismatches, anomaly: mismatches.length > 0 };
}
