// Daily new-ETF-listing / delisting detection against the official TWSE/TPEx feed.
// See lib/cron/newListingDetection.ts for source citations and the disclosed provider-field scope
// limit. Writes ONLY product_listing_events (+ etfs.isActive flip on confirmed delisting, +
// minimal etfs insert when auto-provisioning resolves a unique provider) — same shadow-mode
// write-gate pattern as commodity/index/crypto this round.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { detectNewListings, detectDelistings } from "@/lib/cron/newListingDetection";
import { isNewListingSyncWriteEnabled } from "@/lib/cron/newListingWriteGate";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const JOB = "CLOUD_NEW_LISTING_DETECTION";
  const runKey = `new-listing-detection:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "TWSE_TPEX_OPENDATA", runKey, universeCount: 0, batchSize: 1, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, task: "new-listing-detection", skipped: true });

  const writeEnabled = isNewListingSyncWriteEnabled();
  try {
    const newListings = await detectNewListings(writeEnabled);
    const delistings = await detectDelistings(writeEnabled);
    await finishRun(runId, JOB, "TWSE_TPEX_OPENDATA", started, {
      status: "COMPLETED",
      attempted: newListings.checkedCodes,
      completed: newListings.checkedCodes,
      inserted: newListings.newlyDetected.length,
      updated: delistings.confirmed.length,
      failed: 0,
      retryableFailures: 0,
      checkpointAfter: null,
      details: { newListings, delistings },
    });
    return Response.json({ ok: true, task: "new-listing-detection", writeEnabled, newListings, delistings });
  } catch (e) {
    await finishRun(runId, JOB, "TWSE_TPEX_OPENDATA", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, task: "new-listing-detection", error: (e as Error).message }, { status: 500 });
  }
}
