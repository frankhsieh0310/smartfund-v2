// 選股反查：跨市場掛牌名稱歧義判斷 Yahoo 公司全名/總部國家補值 cron（2026-10-25，使用者核准
// 定案）。見lib/cron/stockYahooProfileBackfill.ts。Shadow mode by default
// (STOCK_YAHOO_PROFILE_BACKFILL_WRITE)，同一套run_key/production_scheduler_runs/checkpoint慣例。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { findStocksMissingYahooProfile, backfillOneStockProfile } from "@/lib/cron/stockYahooProfileBackfill";
import { isStockYahooProfileBackfillWriteEnabled } from "@/lib/cron/stockYahooProfileBackfillWriteGate";
import { newRateStats, sleep } from "@/lib/yahoo/productSession";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_STOCK_YAHOO_PROFILE_BACKFILL";
const PROVIDER = "YAHOO_QUOTE_SUMMARY";
const CHECKPOINT_KEY = "cloud-stock-yahoo-profile-backfill:ROLLING";
const BATCH_SIZE = 500;
const TIME_BUDGET_MS = 250_000;
const PACE_MS = 400;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const writeEnabled = isStockYahooProfileBackfillWriteEnabled();
  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = `cloud-stock-yahoo-profile-backfill:${new Date().toISOString().slice(0, 13)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: 0, batchSize: BATCH_SIZE, checkpointBefore: before });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  const stats = newRateStats();
  let cursor = before?.lastSymbol ?? null;
  let attempted = 0, succeeded = 0, written = 0, failed = 0, stoppedEarly: string | null = null;
  const failureReasons: Record<string, number> = {};

  try {
    while (Date.now() - started < TIME_BUDGET_MS && !stoppedEarly) {
      const batch = await findStocksMissingYahooProfile(BATCH_SIZE, cursor);
      if (batch.length === 0) break;
      for (const stock of batch) {
        if (Date.now() - started >= TIME_BUDGET_MS) break;
        attempted++;
        const result = await backfillOneStockProfile(stock, writeEnabled, stats);
        if (result.ok) { succeeded++; if (result.written) written++; else if (result.failureReason) failureReasons[result.failureReason] = (failureReasons[result.failureReason] ?? 0) + 1; }
        else {
          failed++;
          failureReasons[result.failureReason ?? "UNKNOWN"] = (failureReasons[result.failureReason ?? "UNKNOWN"] ?? 0) + 1;
          if (result.failureReason?.includes("401") || result.failureReason?.includes("403") || result.failureReason?.includes("429") || result.failureReason === "AUTH_401" || result.failureReason === "AUTH_403" || result.failureReason === "RATE_429") {
            stoppedEarly = result.failureReason;
            cursor = stock.ticker;
            break;
          }
        }
        cursor = stock.ticker;
        await sleep(PACE_MS);
      }
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
      details: { writeEnabled, rateStats: stats, failureReasons, stoppedEarly, cursor: after.lastSymbol },
    });
    return Response.json({ ok: status !== "FAILED", job: JOB, writeEnabled, attempted, succeeded, written, failed, failureReasons, stoppedEarly, status, runtimeMs: Date.now() - started });
  } catch (e) {
    await finishRun(runId, JOB, PROVIDER, started, { status: "FAILED", attempted, completed: succeeded, inserted: written, updated: 0, failed: failed + 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message }, { status: 500 });
  }
}
