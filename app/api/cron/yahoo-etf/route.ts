// Cloud Yahoo ETF ingestion — one consolidated worker, phased. No Windows, no local files.
//   /api/cron/yahoo-etf?phase=history   -> v8 chart -> etf_history + etfs latest  (no crumb)
//   /api/cron/yahoo-etf?phase=enrich    -> v10 quoteSummary -> etfs metadata + perf + holdings + allocations
//   /api/cron/yahoo-etf?phase=discover  -> screener ETF universe -> report net-new symbols (no writes)
// Bounded (?batch), resumable (production_scheduler_checkpoints key yahoo-etf-<phase>), run-logged
// (production_scheduler_runs). Stale provider data never overwrites a newer DB row (COALESCE upserts).

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { enrichEtfProduct } from "@/lib/yahoo/etfEnrich";
import { ingestEtfHistory } from "@/lib/yahoo/etfHistory";
import { screenerPage, sleep, type RateStats } from "@/lib/yahoo/productSession";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;
const TIME_BUDGET_MS = 250_000;
const SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,15}$/;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const phase = (url.searchParams.get("phase") ?? "enrich").toLowerCase();
  const batch = Math.min(120, Math.max(1, Number(url.searchParams.get("batch")) || 40));
  const pace = Math.min(4000, Math.max(200, Number(url.searchParams.get("pace")) || 1000));
  const started = Date.now();
  const JOB = `YAHOO_ETF_${phase.toUpperCase()}`;
  const cpKey = `yahoo-etf-${phase}`;
  const runKey = `${cpKey}:${new Date().toISOString().slice(0, 13)}`;
  const stats: RateStats = { calls: 0, rateLimited: 0, crumbRefresh: 0 };

  const cpBefore = await readCheckpoint(cpKey);
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: batch, checkpointBefore: cpBefore,
  });
  if (skipped) return Response.json({ ok: true, task: "yahoo-etf", phase, skipped: true });

  try {
    if (phase === "discover") {
      const page0 = await screenerPage("ETF", [{ operator: "GT", operands: ["fundnetassets", 0] }], 0, 1, "fundnetassets", stats);
      const known = (await query(`SELECT count(*)::int n FROM etfs WHERE is_active = true`, []))[0]?.n ?? 0;
      const details = { yahoo_discoverable: page0.total, smartmatch_existing: Number(known), gap_estimate: Math.max(0, page0.total - Number(known)), stats };
      await finishRun(runId, JOB, "YAHOO", started, {
        status: "COMPLETED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
        checkpointAfter: cpBefore, details,
      });
      return Response.json({ ok: true, task: "yahoo-etf", phase, ...details });
    }

    // history / enrich — cursor over etfs by id
    const cursor = cpBefore?.lastSymbol ?? null;
    const rows = (await query(
      `SELECT id::text, code, data_source,
              CASE WHEN data_source ~ '^[A-Za-z0-9.^=-]{1,15}$' THEN data_source
                   WHEN exchange = 'TWSE' THEN code || '.TW'
                   WHEN exchange = 'TPEx' THEN code || '.TWO' ELSE NULL END AS symbol
         FROM etfs
        WHERE is_active = true AND ($1::text IS NULL OR id > $1)
        ORDER BY id
        LIMIT $2`,
      [cursor, batch],
    )) as Array<{ id: string; code: string; data_source: string | null; symbol: string | null }>;

    let attempted = 0, ok = 0, failed = 0, rowsWritten = 0, holdingsWritten = 0, perfWritten = 0, distEvents = 0, noSymbol = 0;
    let lastId = cursor;
    for (const e of rows) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      lastId = e.id;
      attempted++;
      const sym = (e.symbol ?? "").trim();
      if (!SYMBOL_RE.test(sym)) { noSymbol++; continue; }
      try {
        if (phase === "history") {
          const r = await ingestEtfHistory(query, { etfId: e.id, symbol: sym });
          if (r.ok) { ok++; rowsWritten += r.rowsWritten; distEvents += r.distributionEvents; } else failed++;
        } else {
          const r = await enrichEtfProduct(query, { etfId: e.id, symbol: sym });
          if (r.ok) { ok++; holdingsWritten += r.holdingsWritten; perfWritten += r.performanceWritten; } else failed++;
        }
      } catch { failed++; }
      await sleep(pace);
    }

    const wrapped = rows.length < batch;
    const cpAfter = {
      lastSymbol: wrapped ? null : lastId, processed: (cpBefore?.processed ?? 0) + attempted,
      succeeded: (cpBefore?.succeeded ?? 0) + ok, failed,
    };
    await writeCheckpoint(JOB, cpKey, runId, cpAfter);
    const details = {
      phase, attempted, succeeded: ok, failed, noSymbol, rowsWritten, holdingsWritten, perfWritten, distEvents,
      wrapped, cursor_before: cursor, cursor_after: cpAfter.lastSymbol, stats, runtime_ms: Date.now() - started,
    };
    await finishRun(runId, JOB, "YAHOO", started, {
      status: failed > 0 && ok === 0 ? "PARTIAL" : "COMPLETED",
      attempted, completed: ok, inserted: rowsWritten, updated: perfWritten + holdingsWritten, failed,
      retryableFailures: failed, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details,
    });
    return Response.json({ ok: true, task: "yahoo-etf", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1,
      checkpointAfter: cpBefore, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "yahoo-etf", phase, error: (e as Error).message }, { status: 500 });
  }
}
