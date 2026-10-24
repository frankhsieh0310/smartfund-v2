// 境外基金配息 cron（2026-10-25，使用者核准定案，取代舊的OFFSHORE_DIVIDEND_SYNC/fundclear）。
// 見lib/cron/offshoreDividendTdccSync.ts。TDCC官方開放資料，單次全量抓取（CSV一次下載全部
// 9千多筆，不需要分批逐檔請求），不會有401/403/429問題；萬一真的發生就直接FAILED，不重試繞過。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { syncOffshoreDividendsFromTdcc } from "@/lib/cron/offshoreDividendTdccSync";
import { isOffshoreDividendTdccWriteEnabled } from "@/lib/cron/offshoreDividendTdccWriteGate";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_OFFSHORE_DIVIDEND_TDCC";
const PROVIDER = "TDCC_OPENDATA";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const writeEnabled = isOffshoreDividendTdccWriteEnabled();
  const runKey = `cloud-offshore-dividend-tdcc:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: 0, batchSize: 500, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  try {
    const result = await syncOffshoreDividendsFromTdcc(writeEnabled);
    const status = result.candidateCount === 0 ? "SKIPPED" : writeEnabled && result.written === 0 ? "PARTIAL" : "COMPLETED";
    await finishRun(runId, JOB, PROVIDER, started, {
      status, attempted: result.candidateCount, completed: result.written, inserted: result.written, updated: 0, failed: 0, retryableFailures: 0,
      checkpointAfter: null, error: null,
      details: { writeEnabled, ...result },
    });
    return Response.json({ ok: true, job: JOB, writeEnabled, status, ...result, runtimeMs: Date.now() - started });
  } catch (e) {
    await finishRun(runId, JOB, PROVIDER, started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message }, { status: 500 });
  }
}
