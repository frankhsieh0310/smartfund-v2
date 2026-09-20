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
import { sleep } from "@/lib/yahoo/productSession";
import { fetchDividendHistory, type DividendFetchOutcome } from "@/lib/yahoo/distributionFetch";
import { TW_UNIVERSE_SQL, bulkUpsertEvents, syncTwUpcomingExDates, twProgress, yahooSymbolFor, type EventRow } from "@/lib/yahoo/twEtfDistribution";

// 2026-09-19 Release Data P0 — ONE pipeline, market-prioritised (no per-symbol jobs):
//   universe (DB metadata)  ->  batch of candidates  ->  fetch in bounded-concurrency chunks  ->  normalize
//   ->  ONE bulk upsert per chunk  ->  mark checked_at for finished symbols (checkpoint = DB state)  ->  next chunk.
// * Taiwan ETFs (region/exchange/.TW|.TWO metadata) are tier 0 and are scanned for FULL history (period1=0) whenever
//   distribution_checked_at IS NULL, even if a few events already exist (the daily sweep only ever adds new ones).
// * Outcomes are split: COVERED (events), EMPTY (source answered, no dividends), NOT_AVAILABLE (source has no such
//   symbol) — all three are terminal and stamp checked_at; FAILED (429/5xx/timeout/network) is NOT stamped, so only
//   those are retried on the next run. A failed symbol never aborts its chunk, and a failed chunk write never undoes
//   earlier chunks.
// * Once history is complete, ongoing new distributions arrive from the daily ETF full sweep (events=div on every
//   price update); this job additionally imports OFFICIAL upcoming ex-dates (TWSE/TPEx announcement tables) each run.
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
const CONCURRENCY = 10; // parallel Yahoo chart requests per chunk; one bulk DB write per chunk

// An ETF with distribution_checked_at set was already scanned this era and confirmed to have zero
// distribution events (a real, legitimate outcome for a non-paying ETF) — excluding it here is what
// stops the candidate query from re-selecting the same confirmed-empty ETFs every session.
const CANDIDATE_WHERE = `e.is_active = true AND e.distribution_checked_at IS NULL AND (
    ${TW_UNIVERSE_SQL}
    OR (e.data_source ~ '^[A-Za-z0-9.^=-]{1,15}$'
        AND EXISTS (SELECT 1 FROM etf_history h WHERE h.etf_id = e.id LIMIT 1)))`;
// 2026-09-19 Release Data P3 — global historical repair: every market gets the same full-history scan (checked_at is the
// state), no longer only ETFs with ZERO stored events (those with a few events were left with permanent gaps).
// Priority is data-driven, never a symbol list: 0 = Taiwan, 1 = ETFs with a distribution in the last 400 days, 2 = the rest.
const TIER_SQL = `(CASE WHEN ${TW_UNIVERSE_SQL} THEN 0
       WHEN EXISTS (SELECT 1 FROM etf_distribution_events d WHERE d.etf_id = e.id::text AND d.ex_date >= CURRENT_DATE - 400) THEN 1 ELSE 2 END)`;

async function countRemaining(): Promise<number> {
  return (await query(`SELECT count(*)::int n FROM etfs e WHERE ${CANDIDATE_WHERE}`, []))[0]?.n ?? 0;
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const batch = Math.min(200, Math.max(10, Number(url.searchParams.get("batch")) || 100));
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
    // Official upcoming ex-dates (2 HTTP calls for ALL listed securities; failures are reported, never fatal).
    const upcoming = await syncTwUpcomingExDates(query).catch((e) => ({ error: (e as Error).message }));

    const candidates = (await query(
      `SELECT e.id::text AS id, e.code, e.data_source, e.exchange, (${TW_UNIVERSE_SQL}) AS is_tw
         FROM etfs e
        WHERE ${CANDIDATE_WHERE}
        ORDER BY ${TIER_SQL}, e.id
        LIMIT $1`,
      [batch],
    )) as Array<{ id: string; code: string; data_source: string | null; exchange: string | null; is_tw: boolean }>;

    let attempted = 0, covered = 0, empty = 0, notAvailable = 0, failed = 0, inserted = 0, updated = 0, lastId: string | null = null;
    const failedReasons: Record<string, number> = {};
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const chunk = candidates.slice(i, i + CONCURRENCY);
      const outcomes: Array<{ e: (typeof chunk)[number]; o: DividendFetchOutcome }> = await Promise.all(
        chunk.map(async (e) => {
          const symbol = e.is_tw ? yahooSymbolFor(e) : (e.data_source as string);
          // Full history for every market, daily candles (monthly/weekly candles merge same-bar dividends and lose events).
          return { e, o: await fetchDividendHistory(symbol, { period1: 0 }) };
        }),
      );
      attempted += chunk.length;
      lastId = chunk[chunk.length - 1].id;
      const rows: EventRow[] = [];
      const terminal: string[] = [];
      for (const { e, o } of outcomes) {
        if (o.kind === "FAILED") { failed++; failedReasons[o.reason] = (failedReasons[o.reason] ?? 0) + 1; continue; }
        terminal.push(e.id);
        if (o.kind === "NOT_AVAILABLE") { notAvailable++; continue; }
        if (!o.events.length) { empty++; continue; }
        covered++;
        for (const d of o.events) rows.push({ etfId: e.id, exDate: d.exDate, amount: d.amount, currency: o.currency ?? (e.is_tw ? "TWD" : "USD"), source: "YAHOO_CHART", sourceRecordId: `YAHOO:${o.symbol}:${d.exDate}` });
      }
      try {
        const w = await bulkUpsertEvents(query, rows);
        inserted += w.inserted; updated += w.updated;
        if (terminal.length) await query(`UPDATE etfs SET distribution_checked_at = NOW() WHERE id::text = ANY($1::text[])`, [terminal]);
      } catch {
        // chunk write failed: nothing was stamped, so these symbols are simply retried next run; earlier chunks stay committed.
        failed += terminal.length; failedReasons.DB_WRITE = (failedReasons.DB_WRITE ?? 0) + terminal.length;
      }
      await sleep(150);
    }
    const ok = attempted - failed;
    const eventsWritten = inserted;
    const noEvents = empty;

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
      covered, empty, not_available: notAvailable, events_updated: updated, failed_reasons: failedReasons, concurrency: CONCURRENCY, upcoming_ex_dates: upcoming,
      tw_progress: await twProgress(query).catch(() => null),
      remaining, scan_complete: scanComplete, wrapped: scanComplete,
      checkpoint_before: cpBefore, checkpoint_after: cpAfter, runtime_ms: Date.now() - started,
    };
    await finishRun(runId, JOB, "YAHOO", started, {
      status: attempted > 0 && ok === 0 ? "PARTIAL" : "COMPLETED",
      attempted, completed: ok, inserted: eventsWritten, updated, failed, retryableFailures: failed,
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
