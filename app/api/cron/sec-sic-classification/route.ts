// SEC EDGAR SIC 產業分類每日增量同步（2026-11-11新建，使用者核准）。見
// lib/cron/secSicClassificationIngest.ts開頭說明。~6000檔美股、SEC節流350ms/次，單次cron
// 跑不完，用checkpoint cursor(lastTicker)跨日接續，跟sec-form4-insider-trades同一套慣例。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, hourBucketKey, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { runSecSicClassificationBatch } from "@/lib/cron/secSicClassificationIngest";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const JOB = "SEC_SIC_CLASSIFICATION";
const PROVIDER = "SEC_EDGAR_SUBMISSIONS";
const CHECKPOINT_KEY = "sec-sic-classification:ROLLING";
const TIME_BUDGET_MS = 240_000;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = hourBucketKey("sec-sic-classification");
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: 0, batchSize: 0, checkpointBefore: before });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  try {
    const result = await runSecSicClassificationBatch({ afterTicker: before?.lastSymbol ?? null, timeBudgetMs: TIME_BUDGET_MS });
    const cursor = result.done ? null : result.lastTicker;
    const after = { lastSymbol: cursor, processed: (before?.processed ?? 0) + result.processed, succeeded: (before?.succeeded ?? 0) + result.updated, failed: (before?.failed ?? 0) + result.errors, updatedAt: new Date().toISOString() };
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, after);
    await finishRun(runId, JOB, PROVIDER, started, {
      status: "COMPLETED", attempted: result.processed, completed: result.processed, inserted: 0, updated: result.updated, failed: result.errors, retryableFailures: 0,
      checkpointAfter: after, details: { skippedUntranslated: result.skippedUntranslated, done: result.done },
    });
    return Response.json({ ok: true, job: JOB, ...result, runtimeMs: Date.now() - started });
  } catch (e) {
    const blocked = e instanceof Error && e.message.startsWith("SEC_BLOCKED_");
    await finishRun(runId, JOB, PROVIDER, started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: blocked ? 0 : 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message, blocked }, { status: blocked ? 403 : 500 });
  }
}
