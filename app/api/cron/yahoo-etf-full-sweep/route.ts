// Cloud orchestration wrapper for the ETF full-sweep — history+enrich over ALL active etfs, reading
// and writing the SAME checkpoint the local script (scripts/data/yahoo-ingest/etf-full-sweep.ts) used
// while this was still running on Windows: checkpoint_key = 'yahoo-etf-full-sweep'. This file does NOT
// reimplement ingestion — it calls the identical lib/yahoo/etfHistory.ts + lib/yahoo/etfEnrich.ts
// functions the local script and /api/cron/yahoo-etf already use. It only adds: auth gate, a bounded
// small slice per invocation, a concurrency lock (skip if another invocation is still in-flight), and
// a run log — pure orchestration, so the local sweep's already-completed chunks are never re-touched
// and the cursor picks up from exactly where it left off.
//
// Invoked by app/workflows/etf-full-sweep-cycle.ts in a loop (step -> sleep -> step -> ...) until the
// checkpoint wraps a full lap, so ongoing execution needs no cron cadence shorter than daily and no
// Windows/manual trigger. A daily cron (vercel.json) re-bootstraps the workflow only as a safety net
// in case a run ends early (e.g. a redeploy) without having wrapped.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { enrichEtfProduct } from "@/lib/yahoo/etfEnrich";
import { ingestEtfHistory } from "@/lib/yahoo/etfHistory";
import { sleep, newRateStats, authDiag, authAgeSeconds } from "@/lib/yahoo/productSession";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;
const TIME_BUDGET_MS = 240_000; // stay well under maxDuration so a checkpoint write always happens
const SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,15}$/;
const JOB = "YAHOO_ETF_FULL_SWEEP";
const REPAIR_JOB = "YAHOO_ETF_ENRICH_REPAIR"; // job_id in production_scheduler_failures (reused, no schema change)
const CHECKPOINT_KEY = "yahoo-etf-full-sweep";
const LOCK_WINDOW_MINUTES = 6; // > maxDuration (300s) + margin: a genuinely-alive invocation is still within this

// STEP 8 support: record (or clear) an enrich-core failure in the shared repair queue. Reuses
// production_scheduler_failures (job_id, stock_id) as its PK — no new table, no raw payload stored.
async function recordEnrichOutcome(etfId: string, symbol: string, coreOk: boolean, reason: string | undefined, httpLike: number | null) {
  if (coreOk) {
    await query(
      `UPDATE production_scheduler_failures SET resolved = true, resolved_at = NOW(), resolution_reason = 'REPAIRED_BY_SWEEP'
        WHERE job_id = $1 AND stock_id = $2 AND resolved = false`,
      [REPAIR_JOB, etfId],
    );
    return;
  }
  const backoffMinutes = 15;
  await query(
    `INSERT INTO production_scheduler_failures
       (job_id, stock_id, symbol, attempts, last_error, last_attempted_at, error_type, next_retry_at,
        classification, resolved, first_failed_at, last_http_status)
     VALUES ($1, $2, $3, 1, $4, NOW(), $4, NOW() + ($5 || ' minutes')::interval, 'RETRYABLE_FAILURE', false, NOW(), $6)
     ON CONFLICT (job_id, stock_id) DO UPDATE SET
       symbol = EXCLUDED.symbol, attempts = production_scheduler_failures.attempts + 1,
       last_error = EXCLUDED.last_error, last_attempted_at = NOW(), error_type = EXCLUDED.error_type,
       next_retry_at = NOW() + (LEAST(60, 15 * production_scheduler_failures.attempts) || ' minutes')::interval,
       last_http_status = EXCLUDED.last_http_status,
       resolved = false, resolved_at = NULL, resolution_reason = NULL`,
    [REPAIR_JOB, etfId, symbol, reason ?? "UNKNOWN", backoffMinutes, httpLike],
  );
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const batch = Math.min(150, Math.max(10, Number(url.searchParams.get("batch")) || 75));
  const started = Date.now();
  const stats = newRateStats();

  // --- concurrency lock: reuse production_scheduler_runs as the lease. If a RUNNING row for this
  // job started within the lock window, another invocation is (very likely) still in flight — skip
  // rather than race it for the same checkpoint cursor.
  const inFlight = await query(
    `SELECT id FROM production_scheduler_runs
      WHERE job_id = $1 AND status = 'IN_PROGRESS' AND started_at > NOW() - ($2 || ' minutes')::interval
      LIMIT 1`,
    [JOB, LOCK_WINDOW_MINUTES],
  );
  if (inFlight.length) {
    return Response.json({ ok: true, task: "yahoo-etf-full-sweep", skipped: true, reason: "SKIP_LOCKED" });
  }

  const cpBefore = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = `${CHECKPOINT_KEY}:${started}`; // unique per invocation — the lock above is the real dedup
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: batch, checkpointBefore: cpBefore,
  });
  if (skipped) return Response.json({ ok: true, task: "yahoo-etf-full-sweep", skipped: true, reason: "DUPLICATE_RUN_KEY" });

  try {
    const cursor = cpBefore?.lastSymbol ?? null;
    const rows = (await query(
      `SELECT id::text, code, data_source,
              CASE WHEN data_source ~ '^[A-Za-z0-9.^=-]{1,15}$' THEN data_source
                   WHEN code ~ '^[A-Za-z0-9.^=-]{1,15}$' THEN code ELSE NULL END AS symbol
         FROM etfs
        WHERE is_active = true AND ($1::text IS NULL OR id > $1)
        ORDER BY id
        LIMIT $2`,
      [cursor, batch],
    )) as Array<{ id: string; code: string; data_source: string | null; symbol: string | null }>;

    // Enrich concurrency is (and always has been) 1 — this loop is strictly sequential, one
    // ingestEtfHistory + one enrichEtfProduct call at a time. The cloud enrich-success-rate problem
    // was never a concurrency/rate-limit issue (rate_limited stayed 0) — see productSession.ts's
    // fetchQuoteSummary fix (403-as-retryable, real cookie capture) and the module split below.
    let attempted = 0, histOk = 0, enrichCoreOk = 0, holdingsOk = 0, histRows = 0, holdRows = 0, perfRows = 0, distEvents = 0, failed = 0, noSym = 0;
    let lastId: string | null = cursor;
    for (const e of rows) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      lastId = e.id;
      attempted++;
      const sym = (e.symbol ?? "").trim();
      if (!SYMBOL_RE.test(sym)) { noSym++; continue; }
      try {
        const h = await ingestEtfHistory(query, { etfId: e.id, symbol: sym });
        if (h.ok) { histOk++; histRows += h.rowsWritten; distEvents += h.distributionEvents; } else failed++;
        const p = await enrichEtfProduct(query, { etfId: e.id, symbol: sym }, stats);
        if (p.coreOk) { enrichCoreOk++; perfRows += p.performanceWritten; } else failed++;
        if (p.holdingsOk) { holdingsOk++; holdRows += p.holdingsWritten; }
        await recordEnrichOutcome(e.id, sym, p.coreOk, p.coreOk ? undefined : stats.lastFailure, null);
      } catch { failed++; }
      await sleep(400);
    }

    const wrapped = rows.length < batch; // fewer rows than requested = reached the end of the table
    const cpAfter = {
      lastSymbol: wrapped ? null : lastId,
      processed: (cpBefore?.processed ?? 0) + attempted,
      succeeded: (cpBefore?.succeeded ?? 0) + histOk,
      failed: (cpBefore?.failed ?? 0) + failed,
    };
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, cpAfter);
    // STEP 7: history success must never be reported as "failed" just because enrich/holdings had a
    // bad day — three independent coverage numbers, not one conflated pass/fail per ETF.
    const details = {
      trigger: "CLOUD_SCHEDULED", attempted,
      history_ok: histOk, enrich_core_ok: enrichCoreOk, holdings_ok: holdingsOk,
      failed, no_symbol: noSym,
      history_rows: histRows, holdings_rows: holdRows, performance_rows: perfRows, distribution_rows: distEvents,
      rate_limited: stats.rateLimited, crumb_refresh: stats.crumbRefresh, enrich_failures: stats.failures ?? {},
      auth_cookie_present: authDiag.lastCookiePresent, auth_crumb_present: authDiag.lastCrumbPresent,
      auth_failure_reason: authDiag.lastFailureReason, auth_age_seconds: authAgeSeconds(),
      concurrency: 1,
      checkpoint_before: cpBefore, checkpoint_after: cpAfter, wrapped,
      runtime_ms: Date.now() - started,
    };
    await finishRun(runId, JOB, "YAHOO", started, {
      status: failed > 0 && histOk === 0 && enrichCoreOk === 0 ? "PARTIAL" : "COMPLETED",
      attempted, completed: histOk, inserted: histRows, updated: holdRows + perfRows, failed,
      retryableFailures: failed, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details,
    });
    return Response.json({ ok: true, task: "yahoo-etf-full-sweep", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1,
      checkpointAfter: cpBefore, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "yahoo-etf-full-sweep", error: (e as Error).message }, { status: 500 });
  }
}
