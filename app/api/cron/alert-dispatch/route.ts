// Item 15 dispatcher cron. Shares the ALERT_EVALUATE_WRITE gate with alert-evaluate -- sending a
// push for an occurrence that only exists because the evaluator was write-enabled, so there's no
// scenario where dispatch should be on while evaluation is off.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { runAlertDispatch } from "@/lib/cron/alertDispatch";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "ALERT_DISPATCH";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const writeEnabled = process.env.ALERT_EVALUATE_WRITE === "on";
  const runKey = `alert-dispatch:${new Date().toISOString().slice(0, 16)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "EXPO_PUSH", runKey, universeCount: 0, batchSize: 1, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true });

  try {
    const result = await runAlertDispatch(writeEnabled);
    // 2026-10-22（使用者核准，三.三稽核發現）: 之前不論result.failed都無條件回報COMPLETED。
    // attempted=0是正常情況（沒有新occurrence要發送），不算異常；failed>0才算。
    const status = result.failed > 0 && result.delivered === 0 ? "FAILED" : result.failed > 0 ? "PARTIAL" : "COMPLETED";
    await finishRun(runId, JOB, "EXPO_PUSH", started, {
      status, attempted: result.attempted, completed: result.delivered,
      inserted: 0, updated: 0, failed: result.failed, retryableFailures: 0, checkpointAfter: null,
      details: { writeEnabled, ...result },
    });
    return Response.json({ ok: true, job: JOB, writeEnabled, ...result });
  } catch (e) {
    await finishRun(runId, JOB, "EXPO_PUSH", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message }, { status: 500 });
  }
}
