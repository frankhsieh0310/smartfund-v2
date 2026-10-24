// 全球股票最新價格同步 cron（2026-10-24，使用者核准定案，取代Railway上smartfund-v2服務的
// 同名功能）。見lib/cron/globalStockPriceSync.ts。Shadow mode by default
// (GLOBAL_STOCK_PRICE_SYNC_WRITE)，同一套run_key/production_scheduler_runs/checkpoint慣例。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { findStaleGlobalPriceStocks, syncOneStockPrice } from "@/lib/cron/globalStockPriceSync";
import { isGlobalStockPriceSyncWriteEnabled } from "@/lib/cron/globalStockPriceSyncWriteGate";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_GLOBAL_STOCK_PRICE_SYNC";
const PROVIDER = "YAHOO_CHART";
const CHECKPOINT_KEY = "cloud-global-stock-price-sync:ROLLING";
const BATCH_SIZE = 50;
const TIME_BUDGET_MS = 250_000;
const PACE_MS = 400;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const writeEnabled = isGlobalStockPriceSyncWriteEnabled();
  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = `cloud-global-stock-price-sync:${new Date().toISOString().slice(0, 13)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: 0, batchSize: BATCH_SIZE, checkpointBefore: before });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  let cursor = before?.lastSymbol ?? null;
  let attempted = 0, succeeded = 0, written = 0, failed = 0;
  const failureReasons: Record<string, number> = {};
  let exhaustedUniverse = false;

  try {
    while (Date.now() - started < TIME_BUDGET_MS) {
      const batch = await findStaleGlobalPriceStocks(BATCH_SIZE, cursor);
      if (batch.length === 0) {
        if (cursor === null) break; // 真的沒有任何股票（核心母體持有清單是空的，不應該發生）
        cursor = null; // 這一輪跑到清單尾端，繞回開頭，讓新的一天重新覆蓋
        exhaustedUniverse = true;
        continue;
      }
      for (const stock of batch) {
        if (Date.now() - started >= TIME_BUDGET_MS) break;
        attempted++;
        const result = await syncOneStockPrice(stock, writeEnabled);
        if (result.ok) { succeeded++; if (result.written) written++; }
        else { failed++; failureReasons[result.failureReason ?? "UNKNOWN"] = (failureReasons[result.failureReason ?? "UNKNOWN"] ?? 0) + 1; }
        cursor = stock.ticker;
        await sleep(PACE_MS);
      }
      if (batch.length < BATCH_SIZE && !exhaustedUniverse) { cursor = null; exhaustedUniverse = true; }
    }

    const after = { lastSymbol: cursor, processed: (before?.processed ?? 0) + attempted, succeeded: (before?.succeeded ?? 0) + succeeded, failed: (before?.failed ?? 0) + failed, updatedAt: new Date().toISOString() };
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, after);

    const status: "FAILED" | "PARTIAL" | "SKIPPED" | "COMPLETED" =
      attempted === 0 ? "SKIPPED"
      : failed === attempted ? "FAILED"
      : failed > 0 ? "PARTIAL"
      : "COMPLETED";
    await finishRun(runId, JOB, PROVIDER, started, {
      status, attempted, completed: succeeded, inserted: written, updated: 0, failed,
      retryableFailures: failed, checkpointAfter: after,
      error: failed ? JSON.stringify(failureReasons) : null,
      details: { writeEnabled, failureReasons, cursor: after.lastSymbol },
    });
    return Response.json({ ok: status !== "FAILED", job: JOB, writeEnabled, attempted, succeeded, written, failed, failureReasons, status, runtimeMs: Date.now() - started });
  } catch (e) {
    await finishRun(runId, JOB, PROVIDER, started, { status: "FAILED", attempted, completed: succeeded, inserted: written, updated: 0, failed: failed + 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message }, { status: 500 });
  }
}
