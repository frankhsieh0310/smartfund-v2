// Cloud-only orchestration wrapper for the Yahoo US mutual-fund full sweep. Same pattern as
// /api/cron/yahoo-etf-full-sweep, including the write-isolation + module-split fixes already proven
// there (lib/yahoo/fundIngest.ts enrichFundFromYahoo/ingestUsFundShareClass). This file does not
// reimplement ingestion — pure orchestration: auth, discovery persistence, a bounded slice per
// invocation, a concurrency lock, checkpointing, and a run log.
//
//   ?phase=discover -> discoverAllUsFunds() once, persisted as a production_scheduler_runs row
//     (job_id=YAHOO_FUND_UNIVERSE_DISCOVERY, run_key is date-stable so re-running the same day is a
//     no-op) — no local file, no new table; the symbol array lives in that run's jsonb `details`.
//   ?phase=sweep (default) -> reads the latest discovery's symbol array, walks it with an index
//     cursor persisted in production_scheduler_checkpoints (checkpoint_key='yahoo-fund-full-sweep').
//
// Invoked by app/workflows/fund-full-sweep-cycle.ts in a loop (step -> sleep -> step) until the
// checkpoint wraps a full lap — no cron cadence shorter than daily needed, no Windows, no manual curl.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { discoverAllUsFunds, enrichFundFromYahoo, ingestUsFundShareClass } from "@/lib/yahoo/fundIngest";
import { sleep, newRateStats, authDiag } from "@/lib/yahoo/productSession";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;
const TIME_BUDGET_MS = 240_000;
// Bounded concurrency window for the per-symbol Yahoo fetch + DB write. Safe because
// mastersHoldingsWrittenThisRun's check-then-add in ingestUsFundShareClass has no `await` between
// them, so it stays atomic across interleaved concurrent calls even without a lock. Each item keeps
// its own try/catch (see runOne below) so one fund failing never drops the rest of its chunk.
const SWEEP_CONCURRENCY = 5;
const JOB = "YAHOO_FUND_FULL_SWEEP";
const DISCOVERY_JOB = "YAHOO_FUND_UNIVERSE_DISCOVERY";
const REPAIR_JOB = "YAHOO_FUND_ENRICH_REPAIR";
const CHECKPOINT_KEY = "yahoo-fund-full-sweep";
const LOCK_WINDOW_MINUTES = 6;

async function recordCoreOutcome(symbol: string, coreOk: boolean, reason: string | undefined) {
  if (coreOk) {
    await query(
      `UPDATE production_scheduler_failures SET resolved = true, resolved_at = NOW(), resolution_reason = 'REPAIRED_BY_SWEEP'
        WHERE job_id = $1 AND stock_id = $2 AND resolved = false`,
      [REPAIR_JOB, symbol],
    );
    return;
  }
  await query(
    `INSERT INTO production_scheduler_failures
       (job_id, stock_id, symbol, attempts, last_error, last_attempted_at, error_type, next_retry_at,
        classification, resolved, first_failed_at)
     VALUES ($1, $2, $2, 1, $3, NOW(), $3, NOW() + interval '15 minutes', 'RETRYABLE_FAILURE', false, NOW())
     ON CONFLICT (job_id, stock_id) DO UPDATE SET
       attempts = production_scheduler_failures.attempts + 1, last_error = EXCLUDED.last_error,
       last_attempted_at = NOW(), error_type = EXCLUDED.error_type,
       next_retry_at = NOW() + (LEAST(60, 15 * production_scheduler_failures.attempts) || ' minutes')::interval,
       resolved = false, resolved_at = NULL, resolution_reason = NULL`,
    [REPAIR_JOB, symbol, reason ?? "UNKNOWN"],
  );
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const phase = (url.searchParams.get("phase") ?? "sweep").toLowerCase();
  const batch = Math.min(75, Math.max(25, Number(url.searchParams.get("batch")) || 50));
  const started = Date.now();
  const stats = newRateStats();

  if (phase === "discover") {
    // Check for today's already-COMPLETED discovery run BEFORE paying for a Yahoo screener re-scrape —
    // discoverAllUsFunds() used to run unconditionally every invocation, and beginRun()'s run_key
    // uniqueness only prevented a duplicate DB write, not the expensive re-scrape itself. Two bootstrap
    // re-triggers in one day used to mean two full re-scrapes, which is what starved/timed out the
    // workflow's first step. run_key is already date-stable ("yahoo-fund-universe:YYYY-MM-DD"), so the
    // existing production_scheduler_runs row IS the durable, idempotent marker — no second marker.
    const runKey = `yahoo-fund-universe:${new Date().toISOString().slice(0, 10)}`;
    const existing = await query(
      `SELECT id FROM production_scheduler_runs WHERE job_id = $1 AND run_key = $2 AND status = 'COMPLETED' LIMIT 1`,
      [DISCOVERY_JOB, runKey],
    );
    if (existing.length) {
      console.log("FUND_DISCOVERY_REUSED_TODAY", { runKey });
      return Response.json({ ok: true, task: "yahoo-fund-full-sweep", phase, skipped: true, reason: "ALREADY_DISCOVERED_TODAY" });
    }
    const disc = await discoverAllUsFunds({ stats });
    const { runId, skipped } = await beginRun({
      jobName: DISCOVERY_JOB, provider: "YAHOO", runKey, universeCount: disc.symbols.length, batchSize: 0, checkpointBefore: null,
    });
    if (skipped) return Response.json({ ok: true, task: "yahoo-fund-full-sweep", phase, skipped: true, reason: "ALREADY_DISCOVERED_TODAY" });
    await finishRun(runId, DISCOVERY_JOB, "YAHOO", started, {
      status: "COMPLETED", attempted: disc.symbols.length, completed: disc.symbols.length,
      inserted: 0, updated: 0, failed: 0, retryableFailures: 0, checkpointAfter: null,
      details: { symbols: disc.symbols, top_pass_count: disc.topPassCount, per_category_totals: disc.perCategoryTotals, stats },
    });
    return Response.json({ ok: true, task: "yahoo-fund-full-sweep", phase, discovered: disc.symbols.length, top_pass_count: disc.topPassCount });
  }

  // --- concurrency lock
  const inFlight = await query(
    `SELECT id FROM production_scheduler_runs
      WHERE job_id = $1 AND status = 'IN_PROGRESS' AND started_at > NOW() - ($2 || ' minutes')::interval
      LIMIT 1`,
    [JOB, LOCK_WINDOW_MINUTES],
  );
  if (inFlight.length) return Response.json({ ok: true, task: "yahoo-fund-full-sweep", skipped: true, reason: "SKIP_LOCKED" });

  const discoveryRow = (await query(
    `SELECT details FROM production_scheduler_runs WHERE job_id = $1 AND status = 'COMPLETED' ORDER BY started_at DESC LIMIT 1`,
    [DISCOVERY_JOB],
  ))[0];
  const symbols: string[] = discoveryRow?.details?.symbols ?? [];
  if (!symbols.length) {
    return Response.json({ ok: false, task: "yahoo-fund-full-sweep", error: "NO_DISCOVERY_YET — call ?phase=discover first" }, { status: 409 });
  }

  const cpBefore = await readCheckpoint(CHECKPOINT_KEY);
  const startIdx = cpBefore?.lastSymbol ? Number(cpBefore.lastSymbol) : 0;
  const runKey = `${CHECKPOINT_KEY}:${started}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO", runKey, universeCount: symbols.length, batchSize: batch, checkpointBefore: cpBefore,
  });
  if (skipped) return Response.json({ ok: true, task: "yahoo-fund-full-sweep", skipped: true, reason: "DUPLICATE_RUN_KEY" });

  try {
    const slice = symbols.slice(startIdx, startIdx + batch);
    const mastersHoldingsWrittenThisRun = new Set<string>();

    let attempted = 0, coreOk = 0, navHistoryOk = 0, holdingsOk = 0, morningstarOk = 0, failed = 0;
    let navRows = 0, distRows = 0, holdRows = 0, scIns = 0, scUpd = 0, mCreated = 0, mLinked = 0;

    // One symbol's full fetch+write, isolated: a throw here is caught locally and counted as a
    // failure, never rejecting the Promise.all for its chunk siblings — same failure-isolation
    // contract as the original sequential try/catch, just per-concurrent-item instead of per-loop.
    async function runOne(sym: string): Promise<void> {
      try {
        const rec = await enrichFundFromYahoo(sym, stats);
        if (!rec) {
          failed++;
          await recordCoreOutcome(sym, false, stats.lastFailure);
          return;
        }
        const r = await ingestUsFundShareClass(query, rec, mastersHoldingsWrittenThisRun);
        if (r.coreOk) {
          coreOk++;
          if (r.shareClassInserted) scIns++;
          if (r.shareClassUpdated) scUpd++;
          if (r.masterCreated) mCreated++;
          if (r.masterLinked) mLinked++;
          if (r.morningstar.overall != null || r.morningstar.risk != null || r.morningstar.category) morningstarOk++;
        } else failed++;
        if (r.navHistoryOk) { navHistoryOk++; navRows += r.navRowsWritten; distRows += r.distributionRows; }
        if (r.holdingsOk) { holdingsOk++; holdRows += r.holdingsWritten; }
        await recordCoreOutcome(sym, r.coreOk, r.coreOk ? undefined : (stats.lastFailure ?? "WRITE_FAILED"));
      } catch {
        failed++;
        await recordCoreOutcome(sym, false, "EXCEPTION");
      }
    }

    for (let i = 0; i < slice.length; i += SWEEP_CONCURRENCY) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const chunk = slice.slice(i, i + SWEEP_CONCURRENCY);
      attempted += chunk.length;
      await Promise.all(chunk.map((sym) => runOne(sym)));
      await sleep(500);
    }

    const newIdx = startIdx + slice.length;
    const wrapped = newIdx >= symbols.length;
    const cpAfter = {
      lastSymbol: wrapped ? "0" : String(newIdx),
      processed: (cpBefore?.processed ?? 0) + attempted,
      succeeded: (cpBefore?.succeeded ?? 0) + coreOk,
      failed: (cpBefore?.failed ?? 0) + failed,
    };
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, cpAfter);

    const details = {
      trigger: "CLOUD_SCHEDULED", attempted,
      core_metadata_ok: coreOk, morningstar_ok: morningstarOk, nav_history_ok: navHistoryOk, holdings_ok: holdingsOk,
      failed, nav_rows_written: navRows, distribution_rows: distRows, holdings_written: holdRows,
      share_class_inserted: scIns, share_class_updated: scUpd, master_created: mCreated, master_linked: mLinked,
      rate_limited: stats.rateLimited, crumb_refresh: stats.crumbRefresh, enrich_failures: stats.failures ?? {},
      auth_cookie_present: authDiag.lastCookiePresent, auth_crumb_present: authDiag.lastCrumbPresent,
      universe_size: symbols.length, index_before: startIdx, index_after: cpAfter.lastSymbol, wrapped,
      concurrency: SWEEP_CONCURRENCY, runtime_ms: Date.now() - started,
    };
    await finishRun(runId, JOB, "YAHOO", started, {
      status: failed > 0 && coreOk === 0 ? "PARTIAL" : "COMPLETED",
      attempted, completed: coreOk, inserted: scIns + mCreated, updated: scUpd, failed,
      retryableFailures: failed, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details,
    });
    return Response.json({ ok: true, task: "yahoo-fund-full-sweep", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1,
      checkpointAfter: cpBefore, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "yahoo-fund-full-sweep", error: (e as Error).message }, { status: 500 });
  }
}
