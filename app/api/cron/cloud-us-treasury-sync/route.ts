// 美國公債 cron（2026-10-25，使用者核准定案，取代Railway的smartfund-bond-us-treasury服務）。
// 見lib/cron/usTreasurySync.ts。財政部官方API/CSV，單次全量抓取，不需要分批逐筆請求。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { syncTreasuryAuctions, syncTreasuryYieldCurve } from "@/lib/cron/usTreasurySync";
import { isUsTreasurySyncWriteEnabled } from "@/lib/cron/usTreasurySyncWriteGate";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_US_TREASURY_SYNC";
const PROVIDER = "US_TREASURY_OFFICIAL";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const writeEnabled = isUsTreasurySyncWriteEnabled();
  const runKey = `cloud-us-treasury-sync:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: 0, batchSize: 500, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  try {
    const auctions = await syncTreasuryAuctions(writeEnabled);
    const yields = await syncTreasuryYieldCurve(writeEnabled);
    const totalCandidates = auctions.candidateCount + yields.candidateCount;
    const totalWritten = auctions.written + yields.written;
    const status = totalCandidates === 0 ? "SKIPPED" : writeEnabled && totalWritten === 0 ? "PARTIAL" : "COMPLETED";
    await finishRun(runId, JOB, PROVIDER, started, {
      status, attempted: totalCandidates, completed: totalWritten, inserted: totalWritten, updated: 0, failed: 0, retryableFailures: 0,
      checkpointAfter: null, error: null,
      details: { writeEnabled, auctions, yields },
    });
    return Response.json({ ok: true, job: JOB, writeEnabled, status, auctions, yields, runtimeMs: Date.now() - started });
  } catch (e) {
    await finishRun(runId, JOB, PROVIDER, started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message }, { status: 500 });
  }
}
