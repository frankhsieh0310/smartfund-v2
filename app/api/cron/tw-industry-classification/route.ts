// TWSE/TPEx 官方產業分類每日同步（2026-11-11新建，使用者核准）。見
// lib/cron/twIndustryClassificationIngest.ts開頭說明。資料量小（~2000檔）、無速率限制，每次
// 全量比對，不需要cursor/checkpoint resume——跟既有cloud-etf-price同款run_key慣例，只是不帶
// lastSymbol。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, hourBucketKey } from "@/lib/cloud-ingestion/runContext";
import { runTwIndustryClassificationSync } from "@/lib/cron/twIndustryClassificationIngest";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const JOB = "TW_INDUSTRY_CLASSIFICATION";
const PROVIDER = "TWSE_TPEX_OPENAPI";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const runKey = hourBucketKey("tw-industry-classification");
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: 0, batchSize: 0, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  try {
    const result = await runTwIndustryClassificationSync();
    await finishRun(runId, JOB, PROVIDER, started, {
      status: "COMPLETED", attempted: result.fetched, completed: result.fetched, inserted: 0, updated: result.updated, failed: result.errors, retryableFailures: 0,
      checkpointAfter: null, details: result,
    });
    return Response.json({ ok: true, job: JOB, ...result, runtimeMs: Date.now() - started });
  } catch (e) {
    const blocked = e instanceof Error && e.message.startsWith("BLOCKED_");
    await finishRun(runId, JOB, PROVIDER, started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: blocked ? 0 : 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message, blocked }, { status: blocked ? 403 : 500 });
  }
}
