// 2026-10-23（使用者核准，第二版——不建新表）: 2026-10-23 03:04-05:25 UTC連線池唯讀事故發生時，
// 沒有任何東西主動告警，要等到隔天00:30的daily-health-report才會發現。這支route每15分鐘用正式
// App自己的DATABASE_URL（跟其他cron job走同一條連線路徑）對既有的production_scheduler_runs做
// 一次真實的INSERT（beginRun）+UPDATE（finishRun）──跟其他job本來就會做的run-log記帳動作完全
// 一樣，不需要額外的表。任一步失敗就立刻送Telegram通知，不用等到隔天。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { notifyAnomaly } from "@/lib/daily-health-report/notify";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const JOB = "WRITE_PROBE";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const url = new URL(request.url);

  // 2026-10-23: 受控測試用——只有帶對CRON_SECRET(已經在isAuthorizedCron驗證過)又帶
  // ?simulateFailure=1 時才會走失敗分支，不會真的碰資料庫、不會造成任何真實錯誤，純粹用來驗證
  // Telegram真的能送達。部署後用這個參數觸發一次，確認收到通知，再拿掉參數驗證正常流程。
  const simulateFailure = url.searchParams.get("simulateFailure") === "1";

  // 每次invocation都是獨立一筆（不像其他job需要用run_key防止同一小時重複觸發），所以直接用
  // 完整timestamp當run_key，每15分鐘自然產生新的一筆。
  const runKey = `write-probe:${new Date().toISOString()}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "INTERNAL_WRITE_PROBE", runKey,
    universeCount: 1, batchSize: 1, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  try {
    if (simulateFailure) throw new Error("SIMULATED_FAILURE_FOR_TELEGRAM_TEST (not a real DB error -- triggered by ?simulateFailure=1)");

    await finishRun(runId, JOB, "INTERNAL_WRITE_PROBE", startedMs, {
      status: "COMPLETED", attempted: 1, completed: 1, inserted: 1, updated: 0, failed: 0, retryableFailures: 0,
      checkpointAfter: null, details: {},
    });
    return Response.json({ ok: true, job: JOB, runId, status: "COMPLETED" });
  } catch (e: any) {
    const errorMessage = String(e?.message ?? e);
    const notifyResult = await notifyAnomaly(
      `🔴 WRITE_PROBE失敗（${new Date().toISOString()}）：正式環境資料庫寫入測試失敗，可能是連線池唯讀事故重演。\n錯誤：${errorMessage}`,
    );
    await finishRun(runId, JOB, "INTERNAL_WRITE_PROBE", startedMs, {
      status: "FAILED", attempted: 1, completed: 0, inserted: simulateFailure ? 1 : 0, updated: 0, failed: 1, retryableFailures: 0,
      error: errorMessage, checkpointAfter: null,
      details: { notify: notifyResult, simulated: simulateFailure },
    });
    return Response.json({ ok: false, job: JOB, runId, status: "FAILED", error: errorMessage, notify: notifyResult }, { status: 502 });
  }
}
