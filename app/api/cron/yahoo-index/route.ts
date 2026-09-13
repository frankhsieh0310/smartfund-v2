// Global Index Data Platform — cloud cron worker, mirrors app/api/cron/yahoo-fx/route.ts exactly.
// Replaces the legacy Windows-local, infinite-loop, file-checkpointed
// scripts/data/index/run-global-index.ts with a stateless, DB-checkpointed serverless route.
//
//   /api/cron/yahoo-index?phase=quote   -> full sweep: v7 spark batches (20 symbols/request) over
//                                           the Yahoo-validated core index universe ->
//                                           global_index_snapshots (stale-guarded, intraday only).
//   /api/cron/yahoo-index?phase=history -> full sweep: v8 chart per index, incremental only ->
//                                           global_index_candles (idempotent upsert).
//
// Run-logged (production_scheduler_runs) and checkpointed (production_scheduler_checkpoints),
// reusing lib/cloud-ingestion/runContext.ts exactly as yahoo-fx/yahoo-etf/yahoo-fund already do.
// Writes ONLY global_index_* tables — never touches fx/stock/etf/fund tables, schema, or cron files.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { updateIndexQuotes, updateIndexHistory, CORE_INDEX_SYMBOLS } from "@/lib/cron/indexUpdate";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const TIME_BUDGET_MS = 240_000;
// History batch size follows the FX pipeline's hard-won lesson (see yahoo-fx/route.ts comment):
// per-index Yahoo chart latency on Vercel's network can be much higher than local, so history
// checkpoints after every small batch rather than betting the whole invocation on one big batch.
const HISTORY_BATCH_SIZE = 2;
const HISTORY_MAX_SAFE_RUNTIME_MS = 180_000;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const phase = (url.searchParams.get("phase") ?? "quote").toLowerCase();
  const batch = Math.min(20, Math.max(1, Number(url.searchParams.get("batch")) || 20));
  const started = Date.now();
  const JOB = `YAHOO_INDEX_${phase.toUpperCase()}`;

  if (phase !== "quote" && phase !== "history") {
    return Response.json({ ok: false, task: "yahoo-index", error: `Unknown phase: ${phase}. Use quote|history.` }, { status: 400 });
  }

  const scope = url.searchParams.get("scope") === "smoke" ? CORE_INDEX_SYMBOLS.slice(0, 5) : undefined;
  const cpKey = `yahoo-index-${phase}${scope ? "-smoke" : ""}`;
  const runKey = `${cpKey}:${new Date().toISOString().slice(0, 13)}`;
  const cpBefore = await readCheckpoint(cpKey);
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: batch, checkpointBefore: cpBefore });
  if (skipped) return Response.json({ ok: true, task: "yahoo-index", phase, skipped: true });

  try {
    let cursor = cpBefore?.lastSymbol ?? null;
    if (phase === "quote") {
      let requestedIndexes = 0, updatedIndexes = 0, staleSkipped = 0, noNewData = 0;
      const failedIndexes: Array<{ id: string; symbol: string; reason: string }> = [];
      let wrapped = false, slices = 0;
      while (Date.now() - started < TIME_BUDGET_MS) {
        const r = await updateIndexQuotes(cursor, batch, scope);
        requestedIndexes += r.requestedIndexes; updatedIndexes += r.updatedIndexes; staleSkipped += r.staleSkipped; noNewData += r.noNewData;
        failedIndexes.push(...r.failedIndexes);
        cursor = r.lastId; slices++;
        if (r.wrapped) { wrapped = true; break; }
      }
      const cpAfter = { lastSymbol: wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedIndexes, succeeded: (cpBefore?.succeeded ?? 0) + updatedIndexes, failed: failedIndexes.length };
      await writeCheckpoint(JOB, cpKey, runId, cpAfter);

      await finishRun(runId, JOB, "YAHOO", started, { status: failedIndexes.length > 0 && updatedIndexes === 0 ? "PARTIAL" : "COMPLETED", attempted: requestedIndexes, completed: updatedIndexes, inserted: 0, updated: updatedIndexes, failed: failedIndexes.length, retryableFailures: failedIndexes.length, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details: { slices, wrapped, staleSkipped, noNewData } });
      return Response.json({ ok: true, task: "yahoo-index", phase, requestedIndexes, updatedIndexes, staleSkipped, noNewData, failedIndexes, wrapped, slices });
    } else {
      let requestedIndexes = 0, updatedIndexes = 0, rowsWritten = 0;
      const failedIndexes: Array<{ id: string; symbol: string; reason: string }> = [];
      let wrapped = false, slices = 0;
      while (Date.now() - started < HISTORY_MAX_SAFE_RUNTIME_MS) {
        const r = await updateIndexHistory(cursor, HISTORY_BATCH_SIZE, scope);
        requestedIndexes += r.requestedIndexes; updatedIndexes += r.updatedIndexes; rowsWritten += r.rowsWritten;
        failedIndexes.push(...r.failedIndexes);
        cursor = r.lastId; slices++;
        const cpAfter = { lastSymbol: r.wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedIndexes, succeeded: (cpBefore?.succeeded ?? 0) + updatedIndexes, failed: failedIndexes.length };
        await writeCheckpoint(JOB, cpKey, runId, cpAfter);
        if (r.wrapped) { wrapped = true; break; }
        if (Date.now() - started >= HISTORY_MAX_SAFE_RUNTIME_MS) break;
      }
      const cpAfter = { lastSymbol: wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedIndexes, succeeded: (cpBefore?.succeeded ?? 0) + updatedIndexes, failed: failedIndexes.length };
      await finishRun(runId, JOB, "YAHOO", started, { status: failedIndexes.length > 0 && updatedIndexes === 0 && rowsWritten === 0 ? "PARTIAL" : "COMPLETED", attempted: requestedIndexes, completed: updatedIndexes, inserted: rowsWritten, updated: 0, failed: failedIndexes.length, retryableFailures: failedIndexes.length, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details: { slices, wrapped, batchSize: HISTORY_BATCH_SIZE } });
      return Response.json({ ok: true, task: "yahoo-index", phase, requestedIndexes, updatedIndexes, rowsWritten, failedIndexes, wrapped, slices });
    }
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: cpBefore, error: (e as Error).message });
    return Response.json({ ok: false, task: "yahoo-index", phase, error: (e as Error).message }, { status: 500 });
  }
}
