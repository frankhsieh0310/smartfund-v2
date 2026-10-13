// Cloud consensus reprocessor (Phase 4) — autonomous NEEDS_REVIEW backlog drain + self-healing.
//
// Per invocation:
//   1. one AI Gateway health probe (cached in consensus_meta, re-probed only if stale)
//   2. if not READY  -> do nothing to events, run log AI_BLOCKED, return (ingestion keeps running
//                       elsewhere; the backlog just grows safely)
//   3. if READY      -> drain up to CONSENSUS_MAX_BACKLOG_PER_RUN retryable NEEDS_REVIEW events,
//                       bounded by CONSENSUS_MAX_AI_CALLS_PER_DAY; cache-first; update each event in
//                       place + rebuild only its stock links; then, if anything was reclassified,
//                       re-aggregate 1D / 7D / 30D.
//
// Trigger: workflow step after each consensus-ingest pass -> GET Authorization: Bearer <CRON_SECRET>.
//   ?force=1  re-probe the gateway now   ?batch=<n>  override the per-run cap

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { maybeProbe, aiCallsToday } from "@/lib/consensus/aiHealth";
import { dbAiCache } from "@/lib/consensus/aiCache";
import { drainReviewBacklog } from "@/lib/consensus/reprocess";
import { aggregateConsensus } from "@/lib/consensus/aggregate";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_CONSENSUS_REPROCESS";
const DAILY_CAP = Math.max(1, Number(process.env.CONSENSUS_MAX_AI_CALLS_PER_DAY) || 100);
const BATCH_CAP = Math.max(1, Number(process.env.CONSENSUS_MAX_BACKLOG_PER_RUN) || 50);

const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<never[]>;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";
  const batchCap = Math.min(BATCH_CAP, Math.max(1, Number(url.searchParams.get("batch")) || BATCH_CAP));
  const started = Date.now();

  const runKey = `consensus-reprocess:${new Date().toISOString().slice(0, 13)}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "CONSENSUS", runKey, universeCount: 0, batchSize: batchCap, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, task: "consensus-reprocess", skipped: true });

  try {
    const health = await maybeProbe(query, { force });
    const backlog = (await query(
      `select count(*)::int c from consensus_events where extraction_status = 'NEEDS_REVIEW'`, [],
    ))[0] as unknown as { c: number };

    if (health.status !== "READY") {
      const details = { aiGatewayStatus: health.status, aiDetail: health.detail, needsReviewTotal: backlog.c,
        dailyCap: DAILY_CAP, batchCap, drained: 0, runtimeMs: Date.now() - started };
      await finishRun(runId, JOB, "CONSENSUS", started, {
        status: "SKIPPED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0,
        retryableFailures: 0, checkpointAfter: null, details,
      });
      return Response.json({ ok: true, task: "consensus-reprocess", state: "AI_BLOCKED", ...details });
    }

    const callsToday = await aiCallsToday(query);
    const remainingDailyCalls = Math.max(0, DAILY_CAP - callsToday);
    const cache = dbAiCache(query as never);
    const drain = await drainReviewBacklog(query as never, cache, { batchCap, remainingDailyCalls });

    let aggregate: unknown = null;
    if (drain.reclassified > 0) {
      aggregate = await aggregateConsensus(query as never, { asOf: new Date() });
    }

    const details = {
      aiGatewayStatus: health.status, needsReviewTotal: backlog.c,
      callsToday, dailyCap: DAILY_CAP, remainingDailyCalls, batchCap,
      ...drain, aggregate, runtimeMs: Date.now() - started,
    };
    await finishRun(runId, JOB, "CONSENSUS", started, {
      status: "COMPLETED", attempted: drain.candidates, completed: drain.reclassified,
      inserted: 0, updated: drain.reclassified, failed: drain.stillPending, retryableFailures: drain.stillPending,
      checkpointAfter: null, details,
    });
    return Response.json({ ok: true, task: "consensus-reprocess", state: "AI_READY", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "CONSENSUS", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1,
      retryableFailures: 1, checkpointAfter: null, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "consensus-reprocess", error: (e as Error).message }, { status: 500 });
  }
}
