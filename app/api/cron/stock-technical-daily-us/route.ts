// Daily incremental refresh for stock_technical, US scope (see lib/cron/stockTechnicalDaily.ts
// for the shared compute/write logic -- same file the TW job uses, only the "which stocks are
// stale" query differs). 2026-10-24（選股反查第一階段，使用者核准定案）: stock-technical-daily
// 只做了TW，美股從來沒被排進任何每日更新——AAPL確認停在2026-08-14。Shadow mode by default
// (STOCK_TECHNICAL_SYNC_WRITE_US，跟TW那組gate分開)，先驗證掃描/計算邏輯正確再核准開啟寫入。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { findStaleUsStocks, refreshStockTechnical } from "@/lib/cron/stockTechnicalDaily";
import { isStockTechnicalSyncWriteEnabledUs } from "@/lib/cron/stockTechnicalWriteGate";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const BATCH_SIZE = 100;
const TIME_BUDGET_MS = 250_000;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const JOB = "STOCK_TECHNICAL_DAILY_US";
  const runKey = `stock-technical-daily-us:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "INTERNAL_COMPUTE", runKey, universeCount: 0, batchSize: BATCH_SIZE, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, task: "stock-technical-daily-us", skipped: true });

  const writeEnabled = isStockTechnicalSyncWriteEnabledUs();
  let cursor: string | null = null;
  let totalStale = 0, totalWritten = 0, totalChecked = 0;
  const failed: { ticker: string; reason: string }[] = [];
  try {
    while (Date.now() - started < TIME_BUDGET_MS) {
      const stale = await findStaleUsStocks(BATCH_SIZE, cursor);
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
      if (stale.length < BATCH_SIZE) break; // reached the end of the US universe this pass
      if (Date.now() - started >= TIME_BUDGET_MS) break;
    }
    await finishRun(runId, JOB, "INTERNAL_COMPUTE", started, {
      status: failed.length > 0 && totalWritten === 0 ? "PARTIAL" : "COMPLETED",
      attempted: totalChecked, completed: totalStale, inserted: totalWritten, updated: 0,
      failed: failed.length, retryableFailures: failed.length, checkpointAfter: null,
      details: { writeEnabled, cursor },
    });
    return Response.json({ ok: true, task: "stock-technical-daily-us", writeEnabled, totalChecked, totalStale, totalWritten, failed, cursor });
  } catch (e) {
    await finishRun(runId, JOB, "INTERNAL_COMPUTE", started, { status: "FAILED", attempted: totalChecked, completed: 0, inserted: totalWritten, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, task: "stock-technical-daily-us", error: (e as Error).message }, { status: 500 });
  }
}
