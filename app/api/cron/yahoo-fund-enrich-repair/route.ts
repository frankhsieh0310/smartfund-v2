// Cloud-only repair worker for US mutual-fund symbols whose core metadata/Morningstar failed during
// the full sweep. Reuses production_scheduler_failures (job_id='YAHOO_FUND_ENRICH_REPAIR', stock_id=
// the Yahoo symbol itself — a fund row may not exist yet if quoteSummary never succeeded). Does NOT
// re-fetch NAV history for symbols that already have it — ingestUsFundShareClass's incremental logic
// (last_date - 5d overlap) already handles that; this only re-runs the same lib call.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { enrichFundFromYahoo, ingestUsFundShareClass } from "@/lib/yahoo/fundIngest";
import { sleep, newRateStats, authDiag } from "@/lib/yahoo/productSession";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;
const TIME_BUDGET_MS = 240_000;
const JOB = "YAHOO_FUND_ENRICH_REPAIR";
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
  if (inFlight.length) return Response.json({ ok: true, task: "yahoo-fund-enrich-repair", skipped: true, reason: "SKIP_LOCKED" });

  const runKey = `${JOB}:${started}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: batch, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, task: "yahoo-fund-enrich-repair", skipped: true, reason: "DUPLICATE_RUN_KEY" });

  try {
    const queueRows = (await query(
      `SELECT stock_id AS symbol, attempts FROM production_scheduler_failures
        WHERE job_id = $1 AND resolved = false AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        ORDER BY last_attempted_at ASC
        LIMIT $2`,
      [JOB, batch],
    )) as Array<{ symbol: string; attempts: number }>;

    const mastersHoldingsWrittenThisRun = new Set<string>();
    let attempted = 0, repaired = 0, navAlsoOk = 0, holdingsAlsoOk = 0, stillFailing = 0, markedNotAvailable = 0;
    for (const row of queueRows) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      attempted++;
      try {
        const rec = await enrichFundFromYahoo(row.symbol, stats);
        const ok = rec ? (await ingestUsFundShareClass(query, rec, mastersHoldingsWrittenThisRun)) : null;
        if (ok?.coreOk) {
          repaired++;
          if (ok.navHistoryOk) navAlsoOk++;
          if (ok.holdingsOk) holdingsAlsoOk++;
          await query(
            `UPDATE production_scheduler_failures SET resolved = true, resolved_at = NOW(), resolution_reason = 'REPAIRED'
              WHERE job_id = $1 AND stock_id = $2`,
            [JOB, row.symbol],
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
              [JOB, row.symbol, nextAttempts, stats.lastFailure ?? "UNKNOWN"],
            );
          } else {
            stillFailing++;
            const backoffMinutes = Math.min(240, 15 * nextAttempts);
            await query(
              `UPDATE production_scheduler_failures SET
                 attempts = $3, last_error = $4, last_attempted_at = NOW(), error_type = $4,
                 next_retry_at = NOW() + ($5 || ' minutes')::interval
               WHERE job_id = $1 AND stock_id = $2`,
              [JOB, row.symbol, nextAttempts, stats.lastFailure ?? "UNKNOWN", backoffMinutes],
            );
          }
        }
      } catch { stillFailing++; }
      await sleep(500);
    }

    const remaining = (await query(
      `SELECT count(*)::int n FROM production_scheduler_failures WHERE job_id = $1 AND resolved = false`,
      [JOB],
    ))[0]?.n ?? 0;

    const details = {
      trigger: "CLOUD_SCHEDULED", attempted, repaired, nav_also_ok: navAlsoOk, holdings_also_ok: holdingsAlsoOk,
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
    return Response.json({ ok: true, task: "yahoo-fund-enrich-repair", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1,
      checkpointAfter: null, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "yahoo-fund-enrich-repair", error: (e as Error).message }, { status: 500 });
  }
}
