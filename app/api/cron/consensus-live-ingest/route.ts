// 大佬雷達 V1 — background ingest. Vercel Cron wakes this every 5 minutes; it fetches one bounded
// WallStreetCN window, skips straight to done if nothing is new (AI_CALL_COUNT=0), and otherwise
// extracts + Taiwan-localizes + merges only the genuinely new items into consensus_live_cards. The
// App-facing GET /api/consensus/live route never calls this logic directly — it only reads what this
// route has already persisted.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { runConsensusLiveIngest } from "@/lib/consensusLive/ingest";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const JOB = "CONSENSUS_LIVE_INGEST";
const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<never[]>;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  // 2026-10-22（使用者核准，三.三稽核發現）: 這支route原本完全沒有呼叫beginRun/finishRun，
  // production_scheduler_runs裡完全查不到這個job——不是COMPLETED-on-zero-write，是連「有沒有
  // 跑」都查無紀錄。
  const { runId } = await beginRun({ jobName: JOB, provider: "WALLSTREETCN", runKey: `consensus-live-ingest:${new Date().toISOString().slice(0, 16)}`, universeCount: 0, batchSize: 1, checkpointBefore: null });
  try {
    const result = await runConsensusLiveIngest(query);
    await finishRun(runId, JOB, "WALLSTREETCN", started, {
      status: "COMPLETED", attempted: result.fetched, completed: result.newItems,
      inserted: result.cardsCreated, updated: result.cardsUpdated, failed: 0, retryableFailures: 0, checkpointAfter: null,
      details: result,
    });
    return Response.json({ ok: true, task: "consensus-live-ingest", ...result, runtimeMs: Date.now() - started });
  } catch (e) {
    await finishRun(runId, JOB, "WALLSTREETCN", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, task: "consensus-live-ingest", error: (e as Error).message }, { status: 500 });
  }
}
