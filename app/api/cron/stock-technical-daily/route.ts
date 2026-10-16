// Daily incremental refresh for stock_technical (TW scope only this round -- see
// lib/cron/stockTechnicalDaily.ts for why this is a separate job from the existing backfill
// script and why other markets aren't covered yet). Shadow mode by default
// (STOCK_TECHNICAL_SYNC_WRITE), left off until the final consolidated deploy per instruction.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { findStaleTwStocks, refreshStockTechnical } from "@/lib/cron/stockTechnicalDaily";
import { isStockTechnicalSyncWriteEnabled } from "@/lib/cron/stockTechnicalWriteGate";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const BATCH_SIZE = 100;
const TIME_BUDGET_MS = 250_000;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const JOB = "STOCK_TECHNICAL_DAILY_TW";
  const runKey = `stock-technical-daily-tw:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "INTERNAL_COMPUTE", runKey, universeCount: 0, batchSize: BATCH_SIZE, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, task: "stock-technical-daily", skipped: true });

  const writeEnabled = isStockTechnicalSyncWriteEnabled();
  let cursor: string | null = null;
  let totalStale = 0, totalWritten = 0, totalChecked = 0;
  const failed: { ticker: string; reason: string }[] = [];
  try {
    while (Date.now() - started < TIME_BUDGET_MS) {
      const stale = await findStaleTwStocks(BATCH_SIZE, cursor);
      if (stale.length === 0) break;
      for (const s of stale) {
        totalChecked++;
        try {
          const r = await refreshStockTechnical(s.id, s.latestTechnicalDate, writeEnabled);
          totalStale += r.rowsComputed > 0 ? 1 : 0;
          totalWritten += r.rowsWritten;
        } catch (e) {
          failed.push({ ticker: s.ticker, reason: (e as Error).message });
        }
      }
      cursor = stale[stale.length - 1].ticker;
      if (stale.length < BATCH_SIZE) break; // reached the end of TW universe this pass
      if (Date.now() - started >= TIME_BUDGET_MS) break;
    }
    await finishRun(runId, JOB, "INTERNAL_COMPUTE", started, {
      status: failed.length > 0 && totalWritten === 0 ? "PARTIAL" : "COMPLETED",
      attempted: totalChecked, completed: totalStale, inserted: totalWritten, updated: 0,
      failed: failed.length, retryableFailures: failed.length, checkpointAfter: null,
      details: { writeEnabled, cursor },
    });
    return Response.json({ ok: true, task: "stock-technical-daily", writeEnabled, totalChecked, totalStale, totalWritten, failed, cursor });
  } catch (e) {
    await finishRun(runId, JOB, "INTERNAL_COMPUTE", started, { status: "FAILED", attempted: totalChecked, completed: 0, inserted: totalWritten, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, task: "stock-technical-daily", error: (e as Error).message }, { status: 500 });
  }
}
