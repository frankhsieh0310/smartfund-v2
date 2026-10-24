// 選股反查：台股中文名稱補值 cron（2026-10-24，使用者核准定案）。見
// lib/cron/twCompanyNameZhBackfill.ts 根因說明。Shadow mode by default
// (TW_COMPANY_NAME_ZH_BACKFILL_WRITE)，同一套run_key/production_scheduler_runs/checkpoint慣例。
// 一次性補值性質：補完所有NULL後這支cron每次執行都會是SKIPPED（findStocksMissingNameZh回傳0筆），
// 不需要之後手動關掉。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { findStocksMissingNameZh, backfillOneStockNameZh } from "@/lib/cron/twCompanyNameZhBackfill";
import { isTwCompanyNameZhBackfillWriteEnabled } from "@/lib/cron/twCompanyNameZhBackfillWriteGate";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_TW_COMPANY_NAME_ZH_BACKFILL";
const PROVIDER = "YAHOO_TW_QUOTE_PAGE";
const CHECKPOINT_KEY = "cloud-tw-company-name-zh-backfill:ROLLING";
const BATCH_SIZE = 1000; // 一次性補值，不像基本面同步要每天重跑，批次大一點讓它在幾次執行內補完
const TIME_BUDGET_MS = 250_000;
const PACE_MS = 300;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const writeEnabled = isTwCompanyNameZhBackfillWriteEnabled();
  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = `cloud-tw-company-name-zh-backfill:${new Date().toISOString().slice(0, 13)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: 0, batchSize: BATCH_SIZE, checkpointBefore: before });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  let cursor = before?.lastSymbol ?? null;
  let attempted = 0, succeeded = 0, written = 0, failed = 0, stoppedEarly: string | null = null;
  const failureReasons: Record<string, number> = {};

  try {
    while (Date.now() - started < TIME_BUDGET_MS && !stoppedEarly) {
      const batch = await findStocksMissingNameZh(BATCH_SIZE, cursor);
      if (batch.length === 0) break; // 全部補完
      for (const stock of batch) {
        if (Date.now() - started >= TIME_BUDGET_MS) break;
        attempted++;
        const result = await backfillOneStockNameZh(stock, writeEnabled);
        if (result.ok) { succeeded++; if (result.written) written++; }
        else {
          failed++;
          failureReasons[result.failureReason ?? "UNKNOWN"] = (failureReasons[result.failureReason ?? "UNKNOWN"] ?? 0) + 1;
          if (result.failureReason?.startsWith("RATE_LIMITED")) { stoppedEarly = result.failureReason; cursor = stock.ticker; break; }
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
      details: { writeEnabled, failureReasons, stoppedEarly, cursor: after.lastSymbol },
    });
    return Response.json({ ok: status !== "FAILED", job: JOB, writeEnabled, attempted, succeeded, written, failed, failureReasons, stoppedEarly, status, runtimeMs: Date.now() - started });
  } catch (e) {
    await finishRun(runId, JOB, PROVIDER, started, { status: "FAILED", attempted, completed: succeeded, inserted: written, updated: 0, failed: failed + 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message }, { status: 500 });
  }
}
