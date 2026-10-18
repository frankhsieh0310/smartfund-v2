// Item 15: daily sync of officially-announced upcoming ETF ex-dividend/ex-rights dates from TWSE
// and TPEx's own pre-announcement tables. Write-gated off by default (EX_DATE_SYNC_WRITE=on),
// same shadow-mode-first convention as every other new pipeline this round.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { runExDateSync } from "@/lib/cron/exDateSync";

export const runtime = "nodejs";
// 2026-10-18: raised from 60s after the first production run was killed by Vercel's platform
// timeout at exactly 60s with no error/exception -- 300s matches the budget other crons in this
// project already use (e.g. cloud-moneydj-etf) and gives real headroom while the per-step timing
// log below narrows down which step was actually slow.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "EX_DATE_SYNC";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const writeEnabled = process.env.EX_DATE_SYNC_WRITE === "on";
  const runKey = `ex-date-sync:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "TWSE_TPEX_EXRIGHT", runKey, universeCount: 0, batchSize: 1, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true });

  try {
    const result = await runExDateSync(writeEnabled, (msg) => console.log(msg));
    await finishRun(runId, JOB, "TWSE_TPEX_EXRIGHT", started, {
      status: "COMPLETED", attempted: result.matchedEtfs, completed: result.upserted,
      inserted: result.upserted, updated: 0, failed: result.errors, retryableFailures: 0, checkpointAfter: null,
      details: { writeEnabled, ...result },
    });
    return Response.json({ ok: true, job: JOB, writeEnabled, ...result });
  } catch (e) {
    await finishRun(runId, JOB, "TWSE_TPEX_EXRIGHT", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message }, { status: 500 });
  }
}
