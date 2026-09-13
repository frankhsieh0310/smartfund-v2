// One-time-per-ETF wide-window distribution backfill. The Yahoo full sweep's normal incremental price
// fetch (lib/yahoo/etfHistory.ts) only re-requests a few days of chart data once an ETF already has
// price history, so its `events=div` payload only ever catches NEW distributions going forward for
// the ~7,000+ ETFs already swept before this endpoint existed. This endpoint targets exactly those
// gaps: any active, already-priced ETF with zero rows in etf_distribution_events gets one wider
// (~15-month) chart fetch, dividends only, written the same way (source='YAHOO_CHART', additive,
// never touching the separate 'ISHARES_OFFICIAL_PRODUCT_DISTRIBUTIONS' rows already in that table).
//
// Does NOT touch etf_history, the ETF full-sweep checkpoint, or its concurrency lock — separate job_id
// ('YAHOO_ETF_DISTRIBUTION_BACKFILL'), separate lease, safe to run alongside the full sweep.
//
// 2026-09-11 reliability fix: the Durable Workflow calling this only ever completed ONE step. Root
// cause — this route's own internal deadline only checked BETWEEN candidates, so an ETF with a long
// distribution history (e.g. a weekly-pay product) could push a single invocation's real runtime past
// the *workflow step's* client-side fetch timeout (290s) even though maxDuration is 300s; the
// serverless function kept running server-side and wrote a "COMPLETED" run row, but the workflow step
// that called it had already thrown a timeout error and the workflow run died right there — the
// mismatch between "the endpoint eventually finished" and "the caller gave up first" is what looked
// like "1 slice then nothing". Fixed by (a) a much tighter internal budget with a second deadline
// check inside the per-event insert loop so no single candidate can blow the budget, and (b) an
// explicit `scan_complete` boolean in the response instead of the workflow guessing completion from
// attempted===0 (a SKIP_LOCKED/error response has no `attempted` field either, which was silently
// coerced to 0 and read as "done" — the second bug the caller-side loop had).

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { fetchChartFull, sleep } from "@/lib/yahoo/productSession";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;
// Well under both maxDuration (300s) and the workflow step's client-side fetch timeout (290s, shared
// code in app/workflows/ingestion-steps.ts — not touched here since it's used by every other cron
// step too). Checked both between candidates AND inside the per-event write loop.
const TIME_BUDGET_MS = 150_000;
const JOB = "YAHOO_ETF_DISTRIBUTION_BACKFILL";
const CHECKPOINT_KEY = "yahoo-etf-distribution-backfill";
const LOCK_WINDOW_MINUTES = 6;
const WIDE_WINDOW_SECONDS = 450 * 86_400; // ~15 months of headroom for annual-frequency inference
// Acceptance-test / high-liquidity ETFs get covered first so this doesn't wait on id order.
const PRIORITY_SYMBOLS = ["SPY", "QQQ", "BND", "HYG", "SCHD", "VYM", "AGG", "VOO", "VTI", "GLD", "IEMG", "XLK", "IVV", "VNQ", "LQD"];

async function countRemaining(): Promise<number> {
  return (
    await query(
      `SELECT count(*)::int n FROM etfs e
        WHERE e.is_active = true AND EXISTS (SELECT 1 FROM etf_history h WHERE h.etf_id = e.id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM etf_distribution_events d WHERE d.etf_id = e.id LIMIT 1)`,
      [],
    )
  )[0]?.n ?? 0;
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const batch = Math.min(80, Math.max(10, Number(url.searchParams.get("batch")) || 50));
  const started = Date.now();

  const inFlight = await query(
    `SELECT job_id FROM production_scheduler_runs
      WHERE job_id = $1 AND status = 'IN_PROGRESS' AND started_at > NOW() - ($2 || ' minutes')::interval
      LIMIT 1`,
    [JOB, LOCK_WINDOW_MINUTES],
  );
  if (inFlight.length) return Response.json({ ok: true, task: "yahoo-etf-distribution-backfill", skipped: true, reason: "SKIP_LOCKED", scan_complete: false });

  const cpBefore = await readCheckpoint(CHECKPOINT_KEY); // informational only — NOT used to filter candidates (NOT EXISTS above is the correctness source)
  const runKey = `${JOB}:${started}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: batch, checkpointBefore: cpBefore,
  });
  if (skipped) return Response.json({ ok: true, task: "yahoo-etf-distribution-backfill", skipped: true, reason: "DUPLICATE_RUN_KEY", scan_complete: false });

  try {
    const candidates = (await query(
      `SELECT e.id::text, e.code, e.data_source
         FROM etfs e
        WHERE e.is_active = true
          AND e.data_source ~ '^[A-Za-z0-9.^=-]{1,15}$'
          AND EXISTS (SELECT 1 FROM etf_history h WHERE h.etf_id = e.id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM etf_distribution_events d WHERE d.etf_id = e.id LIMIT 1)
        ORDER BY (CASE WHEN e.code = ANY($1) THEN 0 ELSE 1 END), e.id
        LIMIT $2`,
      [PRIORITY_SYMBOLS, batch],
    )) as Array<{ id: string; code: string; data_source: string }>;

    let attempted = 0, ok = 0, failed = 0, eventsWritten = 0, noEvents = 0, lastId: string | null = null;
    outer: for (const e of candidates) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      attempted++;
      lastId = e.id;
      try {
        const period1 = Math.floor((Date.now() - WIDE_WINDOW_SECONDS * 1000) / 1000);
        const chart = await fetchChartFull(e.data_source, { period1 });
        if (!chart) { failed++; continue; }
        if (!chart.dividends.length) { noEvents++; ok++; continue; }
        for (const d of chart.dividends) {
          if (Date.now() - started > TIME_BUDGET_MS) break outer; // a single long-history ETF must never blow the budget
          if (!(d.amount > 0) || !d.date) continue;
          const r = await query(
            `INSERT INTO etf_distribution_events
               (id, etf_id, share_class_id, ex_date, effective_date, amount, currency, source, source_record_id, verification_status, imported_at, created_at, updated_at)
             VALUES (gen_random_uuid(), $1, 'PRIMARY', $2::date, $2::date, $3, $4, 'YAHOO_CHART', $5, 'SOURCE_PARSED', NOW(), NOW(), NOW())
             ON CONFLICT (etf_id, share_class_id, ex_date, source, source_record_id) DO NOTHING
             RETURNING 1`,
            [e.id, d.date, d.amount, chart.currency ?? "USD", `YAHOO:${e.data_source}:${d.date}`],
          );
          eventsWritten += r.length;
        }
        ok++;
      } catch { failed++; }
      await sleep(400);
    }

    const remaining = await countRemaining();
    // 3: true completion means nothing left to scan — NOT "this batch wrote 0 rows" (plenty of ETFs
    // genuinely have no distributions, which is a normal scanned outcome, not a failure).
    const scanComplete = remaining === 0;

    const cpAfter = {
      lastSymbol: lastId ?? cpBefore?.lastSymbol ?? null,
      processed: (cpBefore?.processed ?? 0) + attempted,
      succeeded: (cpBefore?.succeeded ?? 0) + ok,
      failed: (cpBefore?.failed ?? 0) + failed,
    };
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, cpAfter); // 4: minimal persistent scan state, reusing production_scheduler_checkpoints — no schema change

    const details = {
      trigger: "CLOUD_SCHEDULED", attempted, succeeded: ok, failed, no_events: noEvents, events_written: eventsWritten,
      remaining, scan_complete: scanComplete, wrapped: scanComplete,
      checkpoint_before: cpBefore, checkpoint_after: cpAfter, runtime_ms: Date.now() - started,
    };
    await finishRun(runId, JOB, "YAHOO", started, {
      status: attempted > 0 && ok === 0 ? "PARTIAL" : "COMPLETED",
      attempted, completed: ok, inserted: eventsWritten, updated: 0, failed, retryableFailures: failed,
      checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details,
    });
    return Response.json({ ok: true, task: "yahoo-etf-distribution-backfill", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1,
      checkpointAfter: cpBefore, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "yahoo-etf-distribution-backfill", error: (e as Error).message, scan_complete: false }, { status: 500 });
  }
}
