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
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "YAHOO_COMMODITY_TECHNICAL";
const CP_KEY = "yahoo-commodity-technical";
const BATCH_SIZE = 5;
// 2026-10-18 root-cause fix: this route's own comment claims the ~27-root universe always
// finishes in one invocation (no external fetch, pure DB-to-DB) -- VERIFIED false in production:
// real runs only got through 6/27 (2026-10-16) and 20/27 (2026-10-15) roots before hitting the old
// 45s budget inside a 60s maxDuration. Root cause is the same cross-region DB latency already
// documented for ex-date-sync (Vercel iad1 vs Supabase ap-southeast-1, ~1.1s/round-trip): each
// root does a read + an upsert, so 27 roots can need ~60-90s even with zero external calls. Not a
// region change or a write-strategy change -- just giving this one job the same maxDuration
// headroom every other full-sweep job already has (300s) so a single invocation can actually
// reach every root, matching what the route already claims to do.
const MAX_SAFE_RUNTIME_MS = 280_000;

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
      // 2026-10-18 (使用者規則定案): PARTIAL 判定改成「有任何一項沒寫入就不能回報
      // COMPLETED」-- 原本只有「全部失敗」才算 PARTIAL，會把「大部分成功、少數幾檔沒寫入」
      // 誤報成 COMPLETED。現在只要有任何一檔被跳過，或這次沒有真正跑完整個 universe
      // （!wrapped），就標 PARTIAL。
      status: skippedRoots.length > 0 || !wrapped ? "PARTIAL" : "COMPLETED",
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
