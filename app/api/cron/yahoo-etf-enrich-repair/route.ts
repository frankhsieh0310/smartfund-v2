// Cloud-only repair worker for ETFs whose enrich-core (quoteSummary metadata/performance/holdings)
// failed during the full sweep. Never touches history — that already succeeded for these ETFs
// (history and enrich are independent per STEP 7's split), so this only re-runs the metadata /
// performance / holdings / sector+credit allocation writes via the SAME lib/yahoo/etfEnrich.ts used
// everywhere else. Source of work: production_scheduler_failures (job_id='YAHOO_ETF_ENRICH_REPAIR'),
// populated by /api/cron/yahoo-etf-full-sweep — reused table, no schema change.
//
// Bounded (25-50/invocation), exponential backoff between attempts, and a max-attempts cutoff that
// marks a symbol NOT_AVAILABLE instead of retrying forever (Yahoo genuinely has no quoteSummary data
// for some instruments — that's not a bug to keep re-trying).

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { enrichEtfProduct } from "@/lib/yahoo/etfEnrich";
import { sleep, newRateStats, authDiag } from "@/lib/yahoo/productSession";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;
const TIME_BUDGET_MS = 240_000;
const JOB = "YAHOO_ETF_ENRICH_REPAIR";
const LOCK_WINDOW_MINUTES = 6;
const MAX_ATTEMPTS = 5;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const batch = Math.min(50, Math.max(10, Number(url.searchParams.get("batch")) || 40));
  const started = Date.now();
  const stats = newRateStats();

  const inFlight = await query(
    `SELECT job_id FROM production_scheduler_runs
      WHERE job_id = $1 AND status = 'IN_PROGRESS' AND started_at > NOW() - ($2 || ' minutes')::interval
      LIMIT 1`,
    [JOB, LOCK_WINDOW_MINUTES],
  );
  if (inFlight.length) {
    return Response.json({ ok: true, task: "yahoo-etf-enrich-repair", skipped: true, reason: "SKIP_LOCKED" });
  }

  const runKey = `${JOB}:${started}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: batch, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, task: "yahoo-etf-enrich-repair", skipped: true, reason: "DUPLICATE_RUN_KEY" });

  try {
    // Symbol correction reuses the same TWSE/TPEx -> .TW/.TWO mapping already established in
    // app/api/cron/yahoo-etf/route.ts and run-etf-yahoo-product-modules.ts — exchange-level, not a
    // per-symbol hardcode. Confirmed root cause: 81 Taiwan ETF failures were seeded with a bare
    // code (no Yahoo suffix), so every repair attempt hit an unresolvable Yahoo symbol regardless
    // of retries. classification IS DISTINCT FROM 'NOT_AVAILABLE' stops re-queuing items already
    // marked not-available by the full sweep, whether or not `resolved` was also set on them —
    // without that, a NOT_AVAILABLE-but-unresolved row re-enters this queue forever.
    const queueRows = (await query(
      `SELECT f.stock_id,
              CASE
                WHEN e.exchange = 'TWSE' AND f.symbol !~ '\\.(TW|TWO)$' THEN f.symbol || '.TW'
                WHEN e.exchange = 'TPEx' AND f.symbol !~ '\\.(TW|TWO)$' THEN f.symbol || '.TWO'
                ELSE f.symbol
              END AS symbol,
              f.attempts
         FROM production_scheduler_failures f
         LEFT JOIN etfs e ON e.id::text = f.stock_id
        WHERE f.job_id = $1 AND f.resolved = false AND f.classification IS DISTINCT FROM 'NOT_AVAILABLE'
          AND (f.next_retry_at IS NULL OR f.next_retry_at <= NOW())
        ORDER BY f.last_attempted_at ASC
        LIMIT $2`,
      [JOB, batch],
    )) as Array<{ stock_id: string; symbol: string; attempts: number }>;

    let attempted = 0, repaired = 0, holdingsAlsoOk = 0, stillFailing = 0, markedNotAvailable = 0;
    for (const row of queueRows) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      attempted++;
      try {
        const p = await enrichEtfProduct(query, { etfId: row.stock_id, symbol: row.symbol }, stats);
        if (p.coreOk) {
          repaired++;
          if (p.holdingsOk) holdingsAlsoOk++;
          await query(
            `UPDATE production_scheduler_failures SET resolved = true, resolved_at = NOW(), resolution_reason = 'REPAIRED'
              WHERE job_id = $1 AND stock_id = $2`,
            [JOB, row.stock_id],
          );
        } else {
          const nextAttempts = row.attempts + 1;
          if (nextAttempts >= MAX_ATTEMPTS) {
            markedNotAvailable++;
            await query(
              `UPDATE production_scheduler_failures SET
                 attempts = $3, last_error = $4, last_attempted_at = NOW(), error_type = $4,
                 classification = 'NOT_AVAILABLE', resolved = true, resolved_at = NOW(),
                 resolution_reason = 'MAX_ATTEMPTS_EXCEEDED', next_retry_at = NULL
               WHERE job_id = $1 AND stock_id = $2`,
              [JOB, row.stock_id, nextAttempts, stats.lastFailure ?? "UNKNOWN"],
            );
          } else {
            stillFailing++;
            const backoffMinutes = Math.min(240, 15 * nextAttempts);
            await query(
              `UPDATE production_scheduler_failures SET
                 attempts = $3, last_error = $4, last_attempted_at = NOW(), error_type = $4,
                 next_retry_at = NOW() + ($5 || ' minutes')::interval
               WHERE job_id = $1 AND stock_id = $2`,
              [JOB, row.stock_id, nextAttempts, stats.lastFailure ?? "UNKNOWN", backoffMinutes],
            );
          }
        }
      } catch { stillFailing++; }
      await sleep(400);
    }

    const remaining = (await query(
      `SELECT count(*)::int n FROM production_scheduler_failures WHERE job_id = $1 AND resolved = false`,
      [JOB],
    ))[0]?.n ?? 0;

    const details = {
      trigger: "CLOUD_SCHEDULED", attempted, repaired, holdings_also_ok: holdingsAlsoOk,
      still_failing: stillFailing, marked_not_available: markedNotAvailable, remaining_in_queue: remaining,
      rate_limited: stats.rateLimited, crumb_refresh: stats.crumbRefresh, enrich_failures: stats.failures ?? {},
      auth_cookie_present: authDiag.lastCookiePresent, auth_crumb_present: authDiag.lastCrumbPresent,
      runtime_ms: Date.now() - started,
    };
    await finishRun(runId, JOB, "YAHOO", started, {
      status: attempted > 0 && repaired === 0 ? "PARTIAL" : "COMPLETED",
      attempted, completed: repaired, inserted: 0, updated: repaired, failed: stillFailing,
      retryableFailures: stillFailing, checkpointAfter: null, details,
    });
    return Response.json({ ok: true, task: "yahoo-etf-enrich-repair", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1,
      checkpointAfter: null, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "yahoo-etf-enrich-repair", error: (e as Error).message }, { status: 500 });
  }
}
