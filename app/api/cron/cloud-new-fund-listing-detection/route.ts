// Daily new-domestic-fund / new-offshore-fund detection (see lib/cron/newFundListingDetection.ts
// for the baseline-seed design — neither SITCA's nor TDCC's NAV feed carries an establishment/
// approval date, so "new" is detected by diffing against a persisted baseline, not a date window).
// Shares the NEW_LISTING_SYNC_WRITE gate with the ETF pipeline (lib/cron/newListingDetection.ts) —
// same risk class, same shadow-mode-first requirement.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { detectNewDomesticFunds, detectNewOffshoreFunds } from "@/lib/cron/newFundListingDetection";
import { isNewListingSyncWriteEnabled } from "@/lib/cron/newListingWriteGate";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const JOB = "CLOUD_NEW_FUND_LISTING_DETECTION";
  const runKey = `new-fund-listing-detection:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "SITCA_TDCC", runKey, universeCount: 0, batchSize: 1, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, task: "new-fund-listing-detection", skipped: true });

  const writeEnabled = isNewListingSyncWriteEnabled();
  try {
    const domestic = await detectNewDomesticFunds(writeEnabled);
    const offshore = await detectNewOffshoreFunds(writeEnabled);
    await finishRun(runId, JOB, "SITCA_TDCC", started, {
      status: "COMPLETED",
      attempted: 0, completed: 0,
      inserted: domestic.newlyDetected.length + offshore.newlyDetected.length,
      updated: 0, failed: 0, retryableFailures: 0, checkpointAfter: null,
      details: { domestic, offshore },
    });
    return Response.json({ ok: true, task: "new-fund-listing-detection", writeEnabled, domestic, offshore });
  } catch (e) {
    await finishRun(runId, JOB, "SITCA_TDCC", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, task: "new-fund-listing-detection", error: (e as Error).message }, { status: 500 });
  }
}
