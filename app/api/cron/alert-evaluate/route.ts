// Item 15 evaluator cron. Write-gated off by default (ALERT_EVALUATE_WRITE=on to enable), same
// shadow-mode-first convention as every other new pipeline this round.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { runAlertEvaluate } from "@/lib/cron/alertEvaluate";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const JOB = "ALERT_EVALUATE";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const writeEnabled = process.env.ALERT_EVALUATE_WRITE === "on";
  const runKey = `alert-evaluate:${new Date().toISOString().slice(0, 16)}`; // per-minute bucket, this cron is meant to run frequently
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "INTERNAL", runKey, universeCount: 0, batchSize: 1, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true });

  try {
    const result = await runAlertEvaluate(writeEnabled);
    await finishRun(runId, JOB, "INTERNAL", started, {
      status: "COMPLETED", attempted: result.attempted, completed: result.attempted - result.errors,
      inserted: result.triggeredNew, updated: 0, failed: result.errors, retryableFailures: 0, checkpointAfter: null,
      details: { writeEnabled, ...result },
    });
    return Response.json({ ok: true, job: JOB, writeEnabled, ...result });
  } catch (e) {
    await finishRun(runId, JOB, "INTERNAL", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message }, { status: 500 });
  }
}
