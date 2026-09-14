// Cloud consensus flip detector (Phase 6) — incremental viewpoint-flip detection. No AI.
//
// Scans only (person, symbol, relation) tuples that had a CLASSIFIED event created/updated since the
// checkpoint (production_scheduler_checkpoints key 'consensus-flips'), compares consecutive valid
// stances, and upserts consensus_flip_signals (unique on person+symbol+prev_event+curr_event, so a
// retry never double-inserts). Then builds channel-agnostic alert candidates for STRONG + DIRECT +
// A/B-source push-eligible flips.
//
// Trigger: workflow step after consensus-reprocess -> GET Authorization: Bearer <CRON_SECRET>.
//   ?full=1  rescan everything (ignore checkpoint)

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { detectConsensusFlips, buildAlertCandidates, MAX_FLIP_GAP_DAYS } from "@/lib/consensus/flipDetect";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_CONSENSUS_FLIPS";
const CP_KEY = "consensus-flips";

const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<never[]>;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const full = new URL(request.url).searchParams.get("full") === "1";
  const started = Date.now();

  const runKey = `consensus-flips:${new Date().toISOString().slice(0, 13)}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "CONSENSUS", runKey, universeCount: 0, batchSize: 0, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, task: "consensus-flips", skipped: true });

  try {
    const cp = await readCheckpoint(CP_KEY);
    const sinceIso = full
      ? null
      : cp?.lastSymbol ?? new Date(Date.now() - 30 * 86_400_000).toISOString();

    const detect = await detectConsensusFlips(query as never, { sinceIso });
    const alertCandidatesCreated = await buildAlertCandidates(query as never);

    const totals = (await query(
      `select
         count(*)::int total,
         count(*) filter (where flip_type = 'BEAR_TO_BULL')::int bear_to_bull,
         count(*) filter (where flip_type = 'BULL_TO_BEAR')::int bull_to_bear,
         count(*) filter (where flip_type = 'NEUTRAL_TO_BULL')::int neutral_to_bull,
         count(*) filter (where flip_type = 'NEUTRAL_TO_BEAR')::int neutral_to_bear,
         count(*) filter (where relation_type = 'DIRECT')::int direct_flips,
         count(*) filter (where relation_type = 'INFERRED')::int inferred_flips,
         count(*) filter (where notified_at is not null)::int notified
       from consensus_flip_signals`, [],
    ))[0] as unknown as Record<string, number>;

    const nowIso = new Date().toISOString();
    await writeCheckpoint(JOB, CP_KEY, runId, {
      lastSymbol: nowIso, processed: (cp?.processed ?? 0) + detect.tuplesScanned,
      succeeded: (cp?.succeeded ?? 0) + detect.upserted, failed: cp?.failed ?? 0,
    });

    const details = { since: sinceIso, maxFlipGapDays: MAX_FLIP_GAP_DAYS, ...detect, alertCandidatesCreated, flipTable: totals, runtimeMs: Date.now() - started };
    await finishRun(runId, JOB, "CONSENSUS", started, {
      status: "COMPLETED", attempted: detect.tuplesScanned, completed: detect.upserted,
      inserted: detect.upserted, updated: 0, failed: 0, retryableFailures: 0, checkpointAfter: null, details,
    });
    return Response.json({ ok: true, task: "consensus-flips", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "CONSENSUS", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1,
      retryableFailures: 1, checkpointAfter: null, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "consensus-flips", error: (e as Error).message }, { status: 500 });
  }
}
