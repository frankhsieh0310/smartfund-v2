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
// 2026-10-21（台股拼圖效能回報，使用者單次授權）: 一組語句包成一個交易一次commit——見
// lib/yahoo/etfEnrich.ts TransactionQueryFn 說明。
const queryTx = (statements: Array<{ sql: string; params: unknown[] }>) =>
  prisma.$transaction(statements.map((s) => prisma.$queryRawUnsafe(s.sql, ...s.params))).then(() => undefined);
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
    // 2026-10-18 root-cause fix: this sweep previously treated every is_active ETF row as its own
    // independent candidate, with no awareness of the known duplicate-pair problem (100 pairs,
    // documented in lib/etf-returns-sync/twUniverse.ts) -- VERIFIED this is why the "new"/hidden
    // twin half of each pair (never shown to users, see app/api/mobile/current-market-data/route.ts's
    // display filter) had MORE etf_history/etf_sector_allocations/etf_credit_rating_allocations rows
    // than the canonical row users actually see: this sweep was fetching+writing BOTH halves every
    // lap. Fixed in two parts: (1) the EXISTS clause excludes any row that is the newer half of a
    // duplicate pair (same normalized code, an older sibling exists) -- that row is never a
    // candidate here again; (2) for the canonical (older) row, when its OWN code/data_source isn't a
    // directly fetchable Yahoo symbol (the 57 TWSE bare-code cases -- SYMBOL_RE matches the bare code
    // string itself, but Yahoo has no such ticker), borrow the newer twin's data_source purely as a
    // read-only lookup key, same pattern already applied to market-close-sync.
    const rows = (await query(
      `SELECT bare.id::text, bare.code, bare.data_source,
              CASE WHEN bare.data_source ~ '^[A-Za-z0-9.^=-]{1,15}$' THEN bare.data_source
                   WHEN twin.data_source IS NOT NULL THEN twin.data_source
                   WHEN bare.code ~ '^[A-Za-z0-9.^=-]{1,15}$' THEN bare.code ELSE NULL END AS symbol
         FROM etfs bare
         LEFT JOIN etfs twin ON regexp_replace(twin.code, '\\.(TW|TWO)$', '') = regexp_replace(bare.code, '\\.(TW|TWO)$', '')
                            AND twin.created_at > bare.created_at
        WHERE bare.is_active = true AND ($1::text IS NULL OR bare.id > $1)
          -- 2026-10-19（使用者商品範圍規則，最高層）: 只更新「台灣買得到」的核心母體，
          -- 不再抓非核心 ETF（非 tw_purchasable_classification APPROVED 的長尾商品）。
          AND bare.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'ETF' AND status = 'APPROVED')
          AND NOT EXISTS (
            SELECT 1 FROM etfs older
            WHERE regexp_replace(older.code, '\\.(TW|TWO)$', '') = regexp_replace(bare.code, '\\.(TW|TWO)$', '')
              AND older.created_at < bare.created_at
          )
        ORDER BY bare.id
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
        const p = await enrichEtfProduct(query, { etfId: e.id, symbol: sym }, stats, queryTx);
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
