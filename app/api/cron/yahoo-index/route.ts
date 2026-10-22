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
import { isIndexSyncWriteEnabled } from "@/lib/cron/indexWriteGate";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const TIME_BUDGET_MS = 240_000;
// History batch size follows the FX pipeline's hard-won lesson (see yahoo-fx/route.ts comment):
// per-index Yahoo chart latency on Vercel's network can be much higher than local, so history
// checkpoints after every small batch rather than betting the whole invocation on one big batch.
const HISTORY_BATCH_SIZE = 2;
const HISTORY_MAX_SAFE_RUNTIME_MS = 180_000;
// Hard runtime guard for the history phase. maxDuration is 280s; a new index is only STARTED while at
// least HISTORY_MIN_REMAINING_PER_INDEX_MS remain before HISTORY_DEADLINE_MS (Yahoo call is capped at 20s,
// the batched write is a few statements), so the run always reaches finishRun() and never dangles IN_PROGRESS.
const HISTORY_DEADLINE_MS = 250_000;
const HISTORY_MIN_REMAINING_PER_INDEX_MS = 30_000;

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

  // Market-scoped callers (per-market-close GitHub Actions triggers) pass both `market` (a short
  // label giving that group its own checkpoint/run-key namespace, e.g. "us", "japan") and
  // `symbols` (explicit comma-separated Yahoo tickers for that market's index subset) so each
  // market's cursor never interleaves with the default full-registry sweep's cursor.
  const market = url.searchParams.get("market");
  const explicitSymbols = url.searchParams.get("symbols");
  const scope = explicitSymbols
    ? explicitSymbols.split(",").map((s) => s.trim()).filter(Boolean)
    : url.searchParams.get("scope") === "smoke"
      ? CORE_INDEX_SYMBOLS.slice(0, 5)
      : undefined;
  const scopeKey = market ? `-market:${market}` : scope ? "-smoke" : "";
  const cpKey = `yahoo-index-${phase}${scopeKey}`;
  const runKey = `${cpKey}:${new Date().toISOString().slice(0, 13)}`;
  const cpBefore = await readCheckpoint(cpKey);
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: batch, checkpointBefore: cpBefore });
  if (skipped) return Response.json({ ok: true, task: "yahoo-index", phase, skipped: true });

  const writeEnabled = isIndexSyncWriteEnabled();
  try {
    let cursor = cpBefore?.lastSymbol ?? null;
    if (phase === "quote") {
      let requestedIndexes = 0, updatedIndexes = 0, staleSkipped = 0, noNewData = 0;
      const failedIndexes: Array<{ id: string; symbol: string; reason: string }> = [];
      let wrapped = false, slices = 0;
      while (Date.now() - started < TIME_BUDGET_MS) {
        const r = await updateIndexQuotes(cursor, batch, scope, writeEnabled);
        requestedIndexes += r.requestedIndexes; updatedIndexes += r.updatedIndexes; staleSkipped += r.staleSkipped; noNewData += r.noNewData;
        failedIndexes.push(...r.failedIndexes);
        cursor = r.lastId; slices++;
        if (r.wrapped) { wrapped = true; break; }
      }
      const cpAfter = { lastSymbol: wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedIndexes, succeeded: (cpBefore?.succeeded ?? 0) + updatedIndexes, failed: failedIndexes.length };
      await writeCheckpoint(JOB, cpKey, runId, cpAfter);

      // 2026-10-22（使用者核准，三.三稽核發現）: 之前只有failed>0時才算PARTIAL，write gate關著
      // 或單純沒更新時完全沒guard——VERIFIED global_index_snapshots已經39天沒有新資料，而且這個
      // job完全不在daily-health-report的監控清單裡，兩個問題疊加，完全沒人發現。
      const quoteStatus = failedIndexes.length > 0 && updatedIndexes === 0 ? "PARTIAL"
        : writeEnabled && requestedIndexes > 0 && updatedIndexes === 0 && staleSkipped === 0 ? "PARTIAL"
        : "COMPLETED";
      await finishRun(runId, JOB, "YAHOO", started, { status: quoteStatus, attempted: requestedIndexes, completed: updatedIndexes, inserted: 0, updated: updatedIndexes, failed: failedIndexes.length, retryableFailures: failedIndexes.length, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details: { slices, wrapped, staleSkipped, noNewData, writeEnabled } });
      return Response.json({ ok: true, task: "yahoo-index", phase, writeEnabled, requestedIndexes, updatedIndexes, staleSkipped, noNewData, failedIndexes, wrapped, slices });
    } else {
      let requestedIndexes = 0, updatedIndexes = 0, rowsWritten = 0;
      const failedIndexes: Array<{ id: string; symbol: string; reason: string }> = [];
      let wrapped = false, slices = 0, budgetStopped = false;
      const timings: Array<Record<string, unknown>> = [];
      while (Date.now() - started < HISTORY_MAX_SAFE_RUNTIME_MS) {
        const r = await updateIndexHistory(cursor, HISTORY_BATCH_SIZE, scope, { deadlineAt: started + HISTORY_DEADLINE_MS, minRemainingMs: HISTORY_MIN_REMAINING_PER_INDEX_MS }, writeEnabled);
        requestedIndexes += r.requestedIndexes; updatedIndexes += r.updatedIndexes; rowsWritten += r.rowsWritten;
        failedIndexes.push(...r.failedIndexes);
        cursor = r.lastId; slices++;
        const cpAfter = { lastSymbol: r.wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedIndexes, succeeded: (cpBefore?.succeeded ?? 0) + updatedIndexes, failed: failedIndexes.length };
        const cpStart = Date.now();
        await writeCheckpoint(JOB, cpKey, runId, cpAfter);
        const checkpoint_ms = Date.now() - cpStart;
        for (const t of r.timings) { const line = { ...t, checkpoint_ms }; timings.push(line); console.log(JSON.stringify({ evt: "yahoo-index-history", market, ...line })); }
        if (r.budgetStopped) { budgetStopped = true; break; }
        if (r.wrapped) { wrapped = true; break; }
        if (Date.now() - started >= HISTORY_MAX_SAFE_RUNTIME_MS) break;
      }
      const cpAfter = { lastSymbol: wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedIndexes, succeeded: (cpBefore?.succeeded ?? 0) + updatedIndexes, failed: failedIndexes.length };
      await finishRun(runId, JOB, "YAHOO", started, { status: budgetStopped || (failedIndexes.length > 0 && updatedIndexes === 0 && rowsWritten === 0) ? "PARTIAL" : "COMPLETED", attempted: requestedIndexes, completed: updatedIndexes, inserted: rowsWritten, updated: 0, failed: failedIndexes.length, retryableFailures: failedIndexes.length, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details: { slices, wrapped, batchSize: HISTORY_BATCH_SIZE, budgetStopped, timings, writeEnabled } });
      return Response.json({ ok: true, task: "yahoo-index", phase, writeEnabled, requestedIndexes, updatedIndexes, rowsWritten, failedIndexes, wrapped, slices, budgetStopped });
    }
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: cpBefore, error: (e as Error).message });
    return Response.json({ ok: false, task: "yahoo-index", phase, error: (e as Error).message }, { status: 500 });
  }
}
