// 2026-10-23（使用者核准，第二版——不建新表）: 2026-10-23 03:04-05:25 UTC連線池唯讀事故發生時，
// 沒有任何東西主動告警，要等到隔天00:30的daily-health-report才會發現。這支route每15分鐘用正式
// App自己的DATABASE_URL（跟其他cron job走同一條連線路徑）對既有的production_scheduler_runs做
// 一次真實的INSERT（beginRun）+UPDATE（finishRun）──跟其他job本來就會做的run-log記帳動作完全
// 一樣，不需要額外的表。任一步失敗就立刻送Telegram通知，不用等到隔天。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { notifyAnomaly } from "@/lib/daily-health-report/notify";
import { decideWriteProbeNotification } from "@/lib/cron/writeProbeIncident";

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

    // 2026-11-05（使用者核准）：同一次故障只推送一次，持續故障期間（每15分鐘重跑一次）不要重複
    // 推送；故障超過1小時仍未恢復，最多再提醒一次；恢復時不推送（成功分支本來就不送，不用改）。
    // 判斷「是不是同一次故障」：往回看最近幾筆run，只要連續都是FAILED就算同一個incident，一遇到
    // 非FAILED（或沒有更舊的紀錄）就代表incident從那之後才開始。
    const recentRows = await prisma.$queryRawUnsafe<{ status: string; started_at: string; details: any }[]>(
      `SELECT status, started_at::text, details FROM production_scheduler_runs
        WHERE job_id = $1 AND id != $2
        ORDER BY started_at DESC LIMIT 20`,
      JOB, runId,
    );
    const decision = decideWriteProbeNotification(
      recentRows.map((r) => ({ status: r.status, startedAt: r.started_at, reminderSent: r.details?.reminder_sent === true })),
      new Date(),
    );

    const notifyResult = decision.shouldNotify
      ? await notifyAnomaly(
          decision.isNewIncident
            ? `🔴 WRITE_PROBE失敗（${new Date().toISOString()}）：正式環境資料庫寫入測試失敗，可能是連線池唯讀事故重演。\n錯誤：${errorMessage}`
            : `🔴 WRITE_PROBE持續故障提醒（${new Date().toISOString()}，自${decision.incidentStartedAt.toISOString()}起仍未恢復，已超過1小時）：正式環境資料庫寫入測試持續失敗。\n錯誤：${errorMessage}`,
        )
      : null;

    await finishRun(runId, JOB, "INTERNAL_WRITE_PROBE", startedMs, {
      status: "FAILED", attempted: 1, completed: 0, inserted: simulateFailure ? 1 : 0, updated: 0, failed: 1, retryableFailures: 0,
      error: errorMessage, checkpointAfter: null,
      details: {
        notify: notifyResult, simulated: simulateFailure,
        is_new_incident: decision.isNewIncident, incident_started_at: decision.incidentStartedAt.toISOString(),
        reminder_sent: decision.reminderSentToWrite,
      },
    });
    return Response.json({ ok: false, job: JOB, runId, status: "FAILED", error: errorMessage, notify: notifyResult, isNewIncident: decision.isNewIncident, notified: decision.shouldNotify }, { status: 502 });
  }
}
