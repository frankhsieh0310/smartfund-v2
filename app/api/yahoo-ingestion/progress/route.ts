// READ-ONLY progress status for the long-running Yahoo ETF/Fund cloud ingestion sweeps. Reads only —
// never writes to production_scheduler_checkpoints/runs/failures, never touches a running workflow.
// No new tables; no schema change. Public GET (status pages need to be readable without the cron
// secret) but every query here is a plain SELECT against already-public-shaped aggregate counters —
// no cookie/crumb/PII, no start/stop/reset affordance exists in this file at all.

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = (sql: string, params: unknown[] = []) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;

type RunRow = {
  started_at: Date; completed_at: Date | null; status: string;
  attempted: number | null; completed: number | null; failed: number | null; details: any;
};

function hoursBetween(a: Date, b: Date) {
  return Math.abs(a.getTime() - b.getTime()) / 3_600_000;
}

// ---- shared rolling-throughput / outlier-resistant ETA helper (2026-09-11) ----
// Reused by every job section (distribution backfill + both full sweeps) so a fixed workflow's ETA
// self-corrects the moment real post-fix slices start landing, without a redeploy and without mixing
// in pre-fix/stalled/locked samples. Read-only: only ever SELECTs production_scheduler_runs.

/** Excludes the exact failure shapes that previously corrupted throughput: FAILED runs, a run whose
 * own logged runtime exceeded the workflow step's ~290s fetch timeout (the signature of the timeout
 * bug just fixed), and an anomalous attempted=0 run that isn't a genuine "reached the end" result. */
function isGoodSlice(r: RunRow): boolean {
  if (r.status === "FAILED") return false;
  const runtimeMs = r.details?.runtime_ms;
  if (typeof runtimeMs === "number" && runtimeMs > 290_000) return false;
  const attempted = r.attempted ?? 0;
  if (attempted === 0 && r.details?.scan_complete !== true && r.details?.wrapped !== true) return false;
  return true;
}

/** WALLCLOCK_THROUGHPUT: real processed / real elapsed wall-clock for a trailing window. */
function windowThroughput(goodRunsDesc: RunRow[], now: Date, windowHours: number): { rate: number | null; count: number } {
  const cutoff = new Date(now.getTime() - windowHours * 3_600_000);
  const inWindow = goodRunsDesc.filter((r) => (r.completed_at ?? r.started_at) >= cutoff);
  if (!inWindow.length) return { rate: null, count: 0 };
  const sumAttempted = inWindow.reduce((s, r) => s + (r.attempted ?? 0), 0);
  return { rate: sumAttempted / windowHours, count: inWindow.length };
}

/** ACTIVE_THROUGHPUT over the most recent good slices, outlier-trimmed (E): up to 10 most recent good
 * slices, drop the fastest and slowest one (needs >=5 samples to trim), average the rest. This is the
 * "recent successful cadence" fallback when the 1h wall-clock window doesn't have enough samples yet. */
function recentCadenceRate(goodRunsDesc: RunRow[]): number | null {
  const recent = goodRunsDesc.slice(0, 10);
  const perSliceRates = recent
    .map((r) => {
      const runtimeHours = (r.details?.runtime_ms ?? 0) / 3_600_000;
      return runtimeHours > 0 ? (r.attempted ?? 0) / runtimeHours : null;
    })
    .filter((x): x is number => x != null);
  if (!perSliceRates.length) return null;
  const sorted = [...perSliceRates].sort((a, b) => a - b);
  const trimmed = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

function medianRuntimeSeconds(goodRunsDesc: RunRow[]): number | null {
  const runtimes = goodRunsDesc.slice(0, 10).map((r) => r.details?.runtime_ms).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (!runtimes.length) return null;
  const mid = Math.floor(runtimes.length / 2);
  const ms = runtimes.length % 2 ? runtimes[mid] : (runtimes[mid - 1] + runtimes[mid]) / 2;
  return Math.round(ms / 100) / 10;
}

/** D: LOW/MEDIUM/HIGH — no statistical modeling, just sample count + how long that sample span covers. */
function etaConfidence(goodRunsDesc: RunRow[], now: Date): "LOW" | "MEDIUM" | "HIGH" {
  const recent = goodRunsDesc.slice(0, 10);
  if (!recent.length) return "LOW";
  const spanMinutes = hoursBetween(now, recent[recent.length - 1].started_at) * 60;
  if (recent.length >= 10 && spanMinutes >= 60) return "HIGH";
  if (recent.length >= 3 && spanMinutes >= 20) return "MEDIUM";
  return "LOW";
}

type RollingEta = {
  eta_hours: number | null; estimated_finish_at: string | null;
  eta_basis: "1H_WALLCLOCK" | "RECENT_CADENCE" | "3H_WALLCLOCK" | "STALLED" | "INSUFFICIENT_SAMPLES";
  eta_confidence: "LOW" | "MEDIUM" | "HIGH";
  items_per_hour_1h: number | null; items_per_hour_3h: number | null;
  recent_slice_attempted: number | null; recent_slice_runtime_s: number | null;
  median_slice_runtime_s: number | null;
};

/** B/C/D/G combined: pick the effective rate (1h wall-clock when RUNNING and available, else recent
 * good-slice cadence, else 3h as last resort), apply the >30min-no-progress stalled guard (G) so a
 * paused job never shows a normal countdown, and attach an honest confidence label (D). */
function computeRollingEta(remaining: number, allRunsDesc: RunRow[], now: Date, workflowStatus: string): RollingEta {
  const good = allRunsDesc.filter(isGoodSlice);
  const rate1h = windowThroughput(good, now, 1);
  const rate3h = windowThroughput(good, now, 3);
  const cadence = recentCadenceRate(good);
  const latestAny = allRunsDesc[0];
  const minsSinceLastActivity = latestAny ? hoursBetween(now, latestAny.completed_at ?? latestAny.started_at) * 60 : Infinity;

  const base = {
    items_per_hour_1h: rate1h.rate != null ? Math.round(rate1h.rate) : null,
    items_per_hour_3h: rate3h.rate != null ? Math.round(rate3h.rate) : null,
    recent_slice_attempted: good[0]?.attempted ?? null,
    recent_slice_runtime_s: good[0]?.details?.runtime_ms != null ? Math.round(good[0].details.runtime_ms / 100) / 10 : null,
    median_slice_runtime_s: medianRuntimeSeconds(good),
    eta_confidence: etaConfidence(good, now),
  };

  // G: paused guard wins regardless of confidence/rate availability — never show a normal countdown
  // over data that's actually gone quiet.
  if (minsSinceLastActivity > 30) {
    return { ...base, eta_hours: null, estimated_finish_at: null, eta_basis: "STALLED" };
  }

  let chosenRate: number | null = null;
  let basis: RollingEta["eta_basis"] = "INSUFFICIENT_SAMPLES";
  if (workflowStatus === "RUNNING" && rate1h.rate != null) { chosenRate = rate1h.rate; basis = "1H_WALLCLOCK"; }
  else if (cadence != null) { chosenRate = cadence; basis = "RECENT_CADENCE"; }
  else if (rate3h.rate != null) { chosenRate = rate3h.rate; basis = "3H_WALLCLOCK"; }

  if (chosenRate == null || chosenRate <= 0) {
    return { ...base, eta_hours: null, estimated_finish_at: null, eta_basis: "INSUFFICIENT_SAMPLES" };
  }
  const etaHours = remaining / chosenRate;
  return {
    ...base,
    eta_hours: Math.round(etaHours * 10) / 10,
    estimated_finish_at: new Date(now.getTime() + etaHours * 3_600_000).toISOString(),
    eta_basis: basis,
  };
}

function workflowHealth(processed: number, total: number, latest: RunRow | undefined, now: Date): "RUNNING" | "IDLE" | "STALLED" | "COMPLETED" | "ERROR" {
  if (total > 0 && processed >= total) return "COMPLETED";
  if (!latest) return "IDLE";
  if (latest.status === "FAILED") return "ERROR";
  if (latest.details?.wrapped === true) return "COMPLETED";
  const lastActivity = latest.completed_at ?? latest.started_at;
  const minsSince = hoursBetween(now, lastActivity) * 60;
  return minsSince <= 45 ? "RUNNING" : "STALLED";
}

async function sweepSection(jobId: string, checkpointKey: string, totalFn: () => Promise<number>) {
  const now = new Date();
  const [cpRows, runRows, total] = await Promise.all([
    query(`SELECT last_symbol, processed, succeeded, failed, updated_at FROM production_scheduler_checkpoints WHERE checkpoint_key = $1`, [checkpointKey]),
    query(
      `SELECT started_at, completed_at, status, attempted, completed, failed, details
         FROM production_scheduler_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 60`,
      [jobId],
    ) as Promise<RunRow[]>,
    totalFn(),
  ]);
  const cp = cpRows[0] ?? null;
  const processed = cp?.processed ?? 0;
  const remaining = Math.max(0, total - processed);
  const latest = runRows[0];
  const status = workflowHealth(processed, total, latest, now);
  const eta = computeRollingEta(remaining, runRows, now, status);
  return {
    total,
    processed,
    succeeded: cp?.succeeded ?? 0,
    failed: cp?.failed ?? 0,
    percent_complete: total > 0 ? Math.round(Math.min(100, (processed / total) * 100) * 10) / 10 : 0,
    remaining,
    checkpoint_last_symbol: cp?.last_symbol ?? null,
    last_slice_started_at: latest?.started_at ?? null,
    last_slice_completed_at: latest?.completed_at ?? null,
    workflow_status: status,
    ...eta,
    recent_slices: runRows.slice(0, 10).map((r) => ({
      started_at: r.started_at, completed_at: r.completed_at, status: r.status,
      attempted: r.attempted, succeeded: r.completed, failed: r.failed,
      runtime_ms: r.details?.runtime_ms ?? null,
      checkpoint_after: r.details?.checkpoint_after ?? null,
    })),
  };
}

async function repairSection(jobId: string) {
  const rows = await query(
    `SELECT
        count(*)::int AS total_seeded,
        count(*) FILTER (WHERE resolved AND classification <> 'NOT_AVAILABLE')::int AS resolved,
        count(*) FILTER (WHERE NOT resolved)::int AS pending,
        count(*) FILTER (WHERE classification = 'NOT_AVAILABLE')::int AS not_available,
        max(last_attempted_at) AS last_run_at
      FROM production_scheduler_failures WHERE job_id = $1`,
    [jobId],
  );
  const r = rows[0] ?? { total_seeded: 0, resolved: 0, pending: 0, not_available: 0, last_run_at: null };
  return {
    total_seeded: r.total_seeded,
    resolved: r.resolved,
    pending: r.pending,
    not_available: r.not_available,
    percent_complete: r.total_seeded > 0 ? Math.round(((r.resolved + r.not_available) / r.total_seeded) * 1000) / 10 : 100,
    last_run_at: r.last_run_at,
  };
}

// ETF distribution backfill (/api/cron/yahoo-etf-distribution-backfill) got a minimal persistent
// checkpoint (checkpoint_key='yahoo-etf-distribution-backfill') in the 2026-09-11 reliability fix —
// informational cumulative counters only, correctness still comes from its own NOT EXISTS query, not
// from this checkpoint.
//
// 2026-09-18 fix: "processed" was the `attempted` sum over only the last 60 run rows (a LIMIT 60
// query window) — at batch=35 that's a hard ceiling of 2,100 no matter how much real progress had
// actually happened, and it never reflected the same ETF being legitimately re-attempted across many
// sessions. Real coverage is now derived from the worker's own live `remaining` count (which, since
// the same-day distribution_checked_at fix, correctly excludes ETFs already confirmed to have zero
// distributions): processed = totalUniverse - remaining. The LIMIT 60 window is kept only for the
// ETA throughput estimate, which genuinely needs a recent sample, not a lifetime total.
async function distributionBackfillSection() {
  const now = new Date();
  const JOB = "YAHOO_ETF_DISTRIBUTION_BACKFILL";
  const [runRows, totalRow, coverageRow, cpRows] = await Promise.all([
    query(
      `SELECT started_at, completed_at, status, attempted, completed, failed, details
         FROM production_scheduler_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 60`,
      [JOB],
    ) as Promise<RunRow[]>,
    query(`SELECT count(*)::int n FROM etfs WHERE is_active = true`),
    query(`SELECT count(DISTINCT etf_id)::int etfs, count(*)::int rows FROM etf_distribution_events`),
    query(`SELECT last_symbol, processed, succeeded, failed, updated_at FROM production_scheduler_checkpoints WHERE checkpoint_key = 'yahoo-etf-distribution-backfill'`),
  ]);
  const cpBefore = cpRows[0] ?? null;
  const totalUniverse = Number(totalRow[0]?.n ?? 0);
  const etfsWithData = Number(coverageRow[0]?.etfs ?? 0);
  const distributionRows = Number(coverageRow[0]?.rows ?? 0);

  let recentWindowAttempted = 0, succeeded = 0, failed = 0;
  for (const r of runRows) { recentWindowAttempted += r.attempted ?? 0; succeeded += r.completed ?? 0; failed += r.failed ?? 0; }
  const latest = runRows[0];
  // The worker's own NOT EXISTS count at its last run is the authoritative "remaining"; fall back to
  // (universe - recentWindowAttempted) only if that run detail is ever missing (e.g. no runs yet).
  const liveRemaining = latest?.details?.remaining;
  const remaining = typeof liveRemaining === "number" ? liveRemaining : Math.max(0, totalUniverse - recentWindowAttempted);
  // Real cumulative coverage — never bounded by the recent-run query window above.
  const processed = Math.max(0, totalUniverse - remaining);
  const status = workflowHealth(processed, totalUniverse, latest, now);
  const eta = computeRollingEta(remaining, runRows, now, status);

  return {
    total_target: totalUniverse,
    processed,
    succeeded,
    failed,
    percent_complete: totalUniverse > 0 ? Math.round(Math.min(100, (processed / totalUniverse) * 100) * 10) / 10 : 0,
    remaining,
    // B: two distinct ratios so "0 distributions found" never reads as "backfill failed".
    scan_progress: { processed, total: totalUniverse },
    distribution_coverage: { etfs_with_data: etfsWithData, etfs_scanned: processed },
    etfs_with_distribution_data: etfsWithData,
    distribution_rows: distributionRows,
    recent_window_attempted: recentWindowAttempted,
    last_slice_started_at: latest?.started_at ?? null,
    last_slice_completed_at: latest?.completed_at ?? null,
    workflow_status: status,
    ...eta,
    checkpoint_before: cpBefore,
    checkpoint_after: latest?.details?.checkpoint_after ?? null,
    recent_slices: runRows.slice(0, 10).map((r) => ({
      started_at: r.started_at, completed_at: r.completed_at, status: r.status,
      attempted: r.attempted, succeeded: r.completed, failed: r.failed,
      events_written: r.details?.events_written ?? null,
      runtime_ms: r.details?.runtime_ms ?? null,
    })),
  };
}

async function fundDistributionProgress() {
  const [coverageRows, runRows, checkpointRows] = await Promise.all([
    query(`SELECT count(*)::int AS records, count(DISTINCT fund_id)::int AS funds_with_data, max(ex_date) AS latest_event_date FROM fund_distribution_observations`),
    query(`SELECT job_id, started_at, completed_at, status, attempted, completed, failed, details
             FROM production_scheduler_runs
            WHERE upper(job_id) LIKE '%FUND%'
              AND (upper(job_id) LIKE '%DISTRIBUT%' OR upper(job_id) LIKE '%DIVIDEND%' OR upper(job_id) LIKE '%BACKFILL%')
            ORDER BY started_at DESC LIMIT 1`),
    query(`SELECT checkpoint_key, last_symbol, processed, succeeded, failed, updated_at
             FROM production_scheduler_checkpoints
            WHERE upper(checkpoint_key) LIKE '%FUND%'
              AND (upper(checkpoint_key) LIKE '%DISTRIBUT%' OR upper(checkpoint_key) LIKE '%DIVIDEND%' OR upper(checkpoint_key) LIKE '%BACKFILL%')
            ORDER BY updated_at DESC LIMIT 1`),
  ]);
  const coverage = coverageRows[0] ?? {};
  const run = runRows[0] ?? null;
  const checkpoint = checkpointRows[0] ?? null;
  return {
    records: Number(coverage.records ?? 0),
    funds_with_data: Number(coverage.funds_with_data ?? 0),
    latest_event_date: coverage.latest_event_date ?? null,
    processed: Number(checkpoint?.processed ?? run?.attempted ?? 0),
    succeeded: Number(checkpoint?.succeeded ?? run?.completed ?? 0),
    failed: Number(checkpoint?.failed ?? run?.failed ?? 0),
    remaining: run?.details?.remaining ?? null,
    checkpoint: checkpoint?.last_symbol ?? run?.details?.checkpoint_after ?? null,
    last_completed_at: run?.completed_at ?? null,
    currently_running: run?.status === 'RUNNING' && run?.completed_at == null,
    workflow_status: run ? workflowHealth(Number(checkpoint?.processed ?? 0), Number(run?.details?.total ?? 0), run, new Date()) : 'IDLE',
    job_id: run?.job_id ?? null,
  };
}

export async function GET() {
  const etfTotal = async () => Number((await query(`SELECT count(*)::int n FROM etfs WHERE is_active = true`))[0]?.n ?? 0);
  const fundDiscoveredTotal = async () => {
    const row = (await query(
      `SELECT jsonb_array_length(COALESCE(details->'symbols', '[]'::jsonb)) AS n
         FROM production_scheduler_runs WHERE job_id = 'YAHOO_FUND_UNIVERSE_DISCOVERY' AND status = 'COMPLETED'
        ORDER BY started_at DESC LIMIT 1`,
    ))[0];
    return Number(row?.n ?? 0);
  };

  const [etf, etfRepair, etfDistributionBackfill, fund, fundRepair, fundDistribution] = await Promise.all([
    sweepSection("YAHOO_ETF_FULL_SWEEP", "yahoo-etf-full-sweep", etfTotal),
    repairSection("YAHOO_ETF_ENRICH_REPAIR"),
    distributionBackfillSection(),
    sweepSection("YAHOO_FUND_FULL_SWEEP", "yahoo-fund-full-sweep", fundDiscoveredTotal),
    repairSection("YAHOO_FUND_ENRICH_REPAIR"),
    fundDistributionProgress(),
  ]);

  // Fund-specific extras: master count + Morningstar/holdings success rate from recent run details.
  const fundRuns = await query(
    `SELECT details FROM production_scheduler_runs WHERE job_id = 'YAHOO_FUND_FULL_SWEEP' ORDER BY started_at DESC LIMIT 200`,
  );
  let coreOkSum = 0, morningstarOkSum = 0, holdingsOkSum = 0, attemptedSum = 0;
  for (const r of fundRuns) {
    const d = r.details ?? {};
    coreOkSum += d.core_metadata_ok ?? 0;
    morningstarOkSum += d.morningstar_ok ?? 0;
    holdingsOkSum += d.holdings_ok ?? 0;
    attemptedSum += d.attempted ?? 0;
  }
  const mastersCreated = Number((await query(`SELECT count(*)::int n FROM fund_master WHERE provider_master_key LIKE 'YAHOO:%'`))[0]?.n ?? 0);

  return Response.json({
    ETF_FULL_SWEEP: etf,
    ETF_REPAIR: etfRepair,
    ETF_DISTRIBUTION_BACKFILL: etfDistributionBackfill,
    FUND_FULL_SWEEP: {
      total_discovered: fund.total, processed: fund.processed, succeeded: fund.succeeded, failed: fund.failed,
      percent_complete: fund.percent_complete, remaining: fund.remaining,
      masters_created: mastersCreated,
      morningstar_success_rate: attemptedSum > 0 ? Math.round((morningstarOkSum / attemptedSum) * 1000) / 10 : null,
      holdings_success_rate: attemptedSum > 0 ? Math.round((holdingsOkSum / attemptedSum) * 1000) / 10 : null,
      core_success_rate: attemptedSum > 0 ? Math.round((coreOkSum / attemptedSum) * 1000) / 10 : null,
      items_per_hour_1h: fund.items_per_hour_1h, items_per_hour_3h: fund.items_per_hour_3h,
      recent_slice_attempted: fund.recent_slice_attempted, recent_slice_runtime_s: fund.recent_slice_runtime_s, median_slice_runtime_s: fund.median_slice_runtime_s,
      eta_hours: fund.eta_hours, estimated_finish_at: fund.estimated_finish_at, eta_basis: fund.eta_basis, eta_confidence: fund.eta_confidence,
      last_slice_completed_at: fund.last_slice_completed_at, workflow_status: fund.workflow_status,
      recent_slices: fund.recent_slices,
    },
    FUND_REPAIR: fundRepair,
    FUND_DISTRIBUTION_BACKFILL: fundDistribution,
    SYSTEM: {
      windows_required: false,
      manual_operation_required: false,
      cloud_only: true,
      last_updated_at: new Date().toISOString(),
    },
  });
}
