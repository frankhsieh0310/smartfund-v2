// Task X9 (round-5, section 2-3/3-1): daily technical-indicator sweep for the Commodity Core
// Universe. Unlike yahoo-commodity (which makes an external Yahoo HTTP call per root and needs
// exchange-group-scoped pacing), this route does pure DB-to-DB computation from
// futures_root_market_observations -- no external calls, no rate limit, so the whole ~23-root
// universe finishes in a single invocation every day, no multi-day rotation.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { updateCommodityTechnical } from "@/lib/cron/commodityTechnicalUpdate";
import { isCommoditySyncWriteEnabled } from "@/lib/cron/commodityWriteGate";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "YAHOO_COMMODITY_TECHNICAL";
const CP_KEY = "yahoo-commodity-technical";
const BATCH_SIZE = 5;
const MAX_SAFE_RUNTIME_MS = 45_000;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const writeEnabled = isCommoditySyncWriteEnabled();

  const runKey = `${CP_KEY}:${today}`;
  const cpBefore = await readCheckpoint(CP_KEY);
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "INTERNAL", runKey, universeCount: 0, batchSize: BATCH_SIZE, checkpointBefore: cpBefore });
  if (skipped) return Response.json({ ok: true, task: "yahoo-commodity-technical", skipped: true });

  try {
    let cursor = cpBefore?.lastSymbol ?? null;
    let requestedRoots = 0, updatedRoots = 0;
    const skippedRoots: Array<{ rootId: string; symbol: string; reason: string }> = [];
    let wrapped = false, slices = 0;
    while (Date.now() - started < MAX_SAFE_RUNTIME_MS) {
      const r = await updateCommodityTechnical(cursor, BATCH_SIZE, undefined, writeEnabled);
      requestedRoots += r.requestedRoots; updatedRoots += r.updatedRoots;
      skippedRoots.push(...r.skippedRoots);
      cursor = r.lastId; slices++;
      await writeCheckpoint(JOB, CP_KEY, runId, { lastSymbol: r.wrapped ? null : cursor, processed: requestedRoots, succeeded: updatedRoots, failed: skippedRoots.length });
      if (r.wrapped) { wrapped = true; break; }
    }
    await finishRun(runId, JOB, "INTERNAL", started, {
      status: skippedRoots.length > 0 && updatedRoots === 0 ? "PARTIAL" : "COMPLETED",
      attempted: requestedRoots, completed: updatedRoots, inserted: writeEnabled ? updatedRoots : 0, updated: 0,
      failed: skippedRoots.length, retryableFailures: skippedRoots.length,
      checkpointAfter: { lastSymbol: wrapped ? null : cursor, processed: requestedRoots, succeeded: updatedRoots, failed: skippedRoots.length, updatedAt: new Date().toISOString() },
      details: { slices, wrapped, writeEnabled },
    });
    return Response.json({ ok: true, task: "yahoo-commodity-technical", writeEnabled, requestedRoots, updatedRoots, skippedRoots, wrapped, slices });
  } catch (e) {
    await finishRun(runId, JOB, "INTERNAL", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: cpBefore, error: (e as Error).message });
    return Response.json({ ok: false, task: "yahoo-commodity-technical", error: (e as Error).message }, { status: 500 });
  }
}
