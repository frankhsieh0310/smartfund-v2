// 公開說明書經理費率/保管費率同步（2026-11-04核准，野村投信試點）——這支排程之前都是手動
// 在本機跑runNomuraProspectusFeeSync()驗證，沒有接上任何排程，VERIFIED
// FUND_PROSPECTUS_FEE_WRITE打開在正式環境其實不會有任何效果，直到有排程真的呼叫它。這支是
// 最小的cron包裝，每天跑一次（MOPS公開說明書申報不會每天變，不需要高頻率）。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { runNomuraProspectusFeeSync } from "@/lib/cloud-ingestion/fundProspectusFeeWriter";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const JOB = "FUND_PROSPECTUS_FEE_SYNC";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "NOMURA_MOPS", runKey: `${JOB}:${today}`, universeCount: 0, batchSize: 0, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true });

  try {
    const result = await runNomuraProspectusFeeSync();
    await finishRun(runId, JOB, "NOMURA_MOPS", startedMs, {
      status: "COMPLETED", attempted: result.attempted, completed: result.matched, inserted: result.written,
      updated: 0, failed: result.failed.length, retryableFailures: 0, checkpointAfter: null,
      details: { attempted: result.attempted, matched: result.matched, written: result.written, failedCount: result.failed.length, failedSample: result.failed.slice(0, 20) },
    });
    return Response.json({ ok: true, job: JOB, ...result, dryRunRows: undefined, dryRunRowCount: result.dryRunRows.length });
  } catch (e: any) {
    await finishRun(runId, JOB, "NOMURA_MOPS", startedMs, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1,
      checkpointAfter: null, error: String(e?.message ?? e),
    });
    return Response.json({ ok: false, job: JOB, error: String(e?.message ?? e) }, { status: 500 });
  }
}
