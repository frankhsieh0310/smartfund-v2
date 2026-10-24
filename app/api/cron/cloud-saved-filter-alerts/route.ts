// 選股反查：儲存條件並在符合時提醒 cron（2026-10-24，使用者核准定案）。排在Yahoo基本面同步
// （每小時）與美股技術指標（平日10:00 UTC）之後跑，確保當天有機會拿到較新的資料再比對。
// Shadow mode by default（SAVED_FILTER_ALERT_WRITE），同一套慣例：run_key、
// production_scheduler_runs、0筆嘗試回報SKIPPED不是COMPLETED。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { runSavedFilterAlerts } from "@/lib/cron/savedFilterAlerts";
import { isSavedFilterAlertWriteEnabled } from "@/lib/cron/savedFilterAlertWriteGate";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_SAVED_FILTER_ALERTS";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const writeEnabled = isSavedFilterAlertWriteEnabled();
  const runKey = `cloud-saved-filter-alerts:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "INTERNAL_COMPUTE", runKey, universeCount: 0, batchSize: 1, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true });

  try {
    const result = await runSavedFilterAlerts(writeEnabled);
    const status = result.attempted === 0 ? "SKIPPED" : result.failed > 0 && result.occurrencesCreated === 0 && result.newMatchesFound > 0 ? "FAILED" : result.failed > 0 ? "PARTIAL" : "COMPLETED";
    await finishRun(runId, JOB, "INTERNAL_COMPUTE", started, {
      status, attempted: result.attempted, completed: result.attempted - result.failed,
      inserted: result.occurrencesCreated, updated: 0, failed: result.failed, retryableFailures: result.failed, checkpointAfter: null,
      details: { writeEnabled, ...result },
    });
    return Response.json({ ok: true, job: JOB, writeEnabled, ...result, status, runtimeMs: Date.now() - started });
  } catch (e) {
    await finishRun(runId, JOB, "INTERNAL_COMPUTE", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message }, { status: 500 });
  }
}
