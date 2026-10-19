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
  // 2026-10-19 root-cause fix: shared 120s maxDuration between domestic+offshore detection, but
  // neither side's write loop had any time-budget awareness -- a timeout kill mid-loop never reaches
  // finishRun(), leaving the run stuck IN_PROGRESS forever and only partially creating missing funds
  // (VERIFIED this is why 2026-10-18 only created 63 of 454 approved-missing offshore funds). Give
  // domestic up to 40s and offshore whatever's left of a 100s overall budget (leaving ~20s margin
  // under the 120s maxDuration for the rest of the route + finishRun itself).
  const overallDeadline = started + 100_000;
  const domesticDeadline = Math.min(started + 40_000, overallDeadline);
  try {
    const domestic = await detectNewDomesticFunds(writeEnabled, domesticDeadline);
    const offshore = await detectNewOffshoreFunds(writeEnabled, overallDeadline);
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
