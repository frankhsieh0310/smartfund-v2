// SmartMatch Commodity Core Universe — cloud cron worker, mirrors app/api/cron/yahoo-index/route.ts
// and app/api/cron/yahoo-crypto/route.ts exactly. Single market-level owner for the fixed 18-root
// Commodity Core Universe (lib/cron/commodityUpdate.ts) — no per-symbol scheduler, no quote/
// intraday phase (daily finalized close only, per this round's explicit scope).
//
//   /api/cron/yahoo-commodity?phase=history -> full sweep: v8 chart per commodity root,
//                                               incremental only -> futures_root_market_observations
//                                               (idempotent upsert on existing unique key).
//
// Run-logged (production_scheduler_runs) and checkpointed (production_scheduler_checkpoints),
// reusing lib/cloud-ingestion/runContext.ts exactly as yahoo-fx/yahoo-index/yahoo-crypto already do.
// Writes ONLY futures_root_market_observations rows for the 18 Commodity Core Universe roots —
// never touches any other futures/commodity table or the separate Futures Live Auto Sync work.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { updateCommodityHistory, CORE_COMMODITY_ROOTS } from "@/lib/cron/commodityUpdate";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const HISTORY_BATCH_SIZE = 3;
const HISTORY_MAX_SAFE_RUNTIME_MS = 180_000;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const phase = (url.searchParams.get("phase") ?? "history").toLowerCase();
  const started = Date.now();
  const JOB = `YAHOO_COMMODITY_${phase.toUpperCase()}`;

  if (phase !== "history") {
    return Response.json({ ok: false, task: "yahoo-commodity", error: `Unknown phase: ${phase}. Use history.` }, { status: 400 });
  }

  // Market-close-scoped callers (per-exchange-group GitHub Actions triggers) pass both `group` (a
  // short label giving that exchange group its own checkpoint/run-key namespace, e.g.
  // "comex-nymex", "cbot") and `symbols` (explicit comma-separated Yahoo tickers for that group)
  // so each group's cursor never interleaves with the default full-universe sweep's cursor.
  const group = url.searchParams.get("group");
  const explicitSymbols = url.searchParams.get("symbols");
  const scope = explicitSymbols
    ? CORE_COMMODITY_ROOTS.filter((r) => explicitSymbols.split(",").map((s) => s.trim()).includes(r.yahooSymbol))
    : undefined;
  const cpKey = group ? `yahoo-commodity-history-group:${group}` : "yahoo-commodity-history";
  const runKey = `${cpKey}:${new Date().toISOString().slice(0, 13)}`;
  const cpBefore = await readCheckpoint(cpKey);
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: HISTORY_BATCH_SIZE, checkpointBefore: cpBefore });
  if (skipped) return Response.json({ ok: true, task: "yahoo-commodity", phase, skipped: true });

  try {
    let cursor = cpBefore?.lastSymbol ?? null;
    let requestedRoots = 0, updatedRoots = 0, rowsWritten = 0;
    const failedRoots: Array<{ rootId: string; symbol: string; reason: string }> = [];
    let wrapped = false, slices = 0;
    while (Date.now() - started < HISTORY_MAX_SAFE_RUNTIME_MS) {
      const r = await updateCommodityHistory(cursor, HISTORY_BATCH_SIZE, scope);
      requestedRoots += r.requestedRoots; updatedRoots += r.updatedRoots; rowsWritten += r.rowsWritten;
      failedRoots.push(...r.failedRoots);
      cursor = r.lastId; slices++;
      const cpAfter = { lastSymbol: r.wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedRoots, succeeded: (cpBefore?.succeeded ?? 0) + updatedRoots, failed: failedRoots.length };
      await writeCheckpoint(JOB, cpKey, runId, cpAfter);
      if (r.wrapped) { wrapped = true; break; }
      if (Date.now() - started >= HISTORY_MAX_SAFE_RUNTIME_MS) break;
    }
    const cpAfter = { lastSymbol: wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedRoots, succeeded: (cpBefore?.succeeded ?? 0) + updatedRoots, failed: failedRoots.length };
    await finishRun(runId, JOB, "YAHOO", started, { status: failedRoots.length > 0 && updatedRoots === 0 && rowsWritten === 0 ? "PARTIAL" : "COMPLETED", attempted: requestedRoots, completed: updatedRoots, inserted: rowsWritten, updated: 0, failed: failedRoots.length, retryableFailures: failedRoots.length, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details: { slices, wrapped, batchSize: HISTORY_BATCH_SIZE } });
    return Response.json({ ok: true, task: "yahoo-commodity", phase, requestedRoots, updatedRoots, rowsWritten, failedRoots, wrapped, slices });
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: cpBefore, error: (e as Error).message });
    return Response.json({ ok: false, task: "yahoo-commodity", phase, error: (e as Error).message }, { status: 500 });
  }
}
