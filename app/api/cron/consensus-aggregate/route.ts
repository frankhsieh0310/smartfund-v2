// Cloud consensus aggregate worker (Phase I) — recompute 1D / 7D / 30D stock + sector rollups.
//
// Deterministic: reads consensus_events + consensus_stock_links, writes consensus_stock_daily /
// consensus_sector_daily for today's date. Idempotent (upsert on (date, window, symbol|sector)).
// Trigger: 06:30 Asia/Taipei via cloud scheduler -> GET with Authorization: Bearer <CRON_SECRET>.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { aggregateConsensus, type QueryFn } from "@/lib/consensus/aggregate";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_CONSENSUS_AGGREGATE";

const query: QueryFn = (sql, params) => prisma.$queryRawUnsafe(sql, ...(params as unknown[])) as Promise<never[]>;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const runKey = `consensus-aggregate:${new Date().toISOString().slice(0, 13)}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "CONSENSUS", runKey, universeCount: 0, batchSize: 0, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, task: "consensus-aggregate", skipped: true });

  try {
    const totalEvents = (await query<{ c: number }>(
      `select count(*)::int c from consensus_events where extraction_status = 'CLASSIFIED'`, [],
    ))[0]?.c ?? 0;
    const result = await aggregateConsensus(query, { asOf: new Date() });
    await finishRun(runId, JOB, "CONSENSUS", started, {
      status: "COMPLETED", attempted: totalEvents, completed: totalEvents,
      inserted: result.stockRows, updated: 0, failed: 0, retryableFailures: 0, checkpointAfter: null,
      details: { ...result, classifiedEvents: totalEvents, runtimeMs: Date.now() - started },
    });
    return Response.json({ ok: true, task: "consensus-aggregate", ...result, classifiedEvents: totalEvents });
  } catch (e) {
    await finishRun(runId, JOB, "CONSENSUS", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1,
      retryableFailures: 1, checkpointAfter: null, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "consensus-aggregate", error: (e as Error).message }, { status: 500 });
  }
}
