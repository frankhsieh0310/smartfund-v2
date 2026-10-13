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
