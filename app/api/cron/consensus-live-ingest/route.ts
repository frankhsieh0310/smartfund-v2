// 大佬雷達 V1 — background ingest. Vercel Cron wakes this every 5 minutes; it fetches one bounded
// WallStreetCN window, skips straight to done if nothing is new (AI_CALL_COUNT=0), and otherwise
// extracts + Taiwan-localizes + merges only the genuinely new items into consensus_live_cards. The
// App-facing GET /api/consensus/live route never calls this logic directly — it only reads what this
// route has already persisted.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { runConsensusLiveIngest } from "@/lib/consensusLive/ingest";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<never[]>;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  try {
    const result = await runConsensusLiveIngest(query);
    return Response.json({ ok: true, task: "consensus-live-ingest", ...result, runtimeMs: Date.now() - started });
  } catch (e) {
    return Response.json({ ok: false, task: "consensus-live-ingest", error: (e as Error).message }, { status: 500 });
  }
}
