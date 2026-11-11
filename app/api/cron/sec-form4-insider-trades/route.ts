// SEC Form 4 insider-ownership 每日增量擷取（2026-11-11新建，使用者核准）。見
// lib/cron/secForm4Ingest.ts開頭說明：這張表(insider_ownership_transactions)原本完全沒有排程，
// 這是第一次補上。同一套run_key/production_scheduler_runs/checkpoint慣例（cloud-etf-price同款）。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, hourBucketKey, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { runSecForm4IngestBatch } from "@/lib/cron/secForm4Ingest";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const JOB = "SEC_FORM4_INSIDER_TRADES";
const PROVIDER = "SEC_EDGAR_FORM4";
const CHECKPOINT_KEY = "sec-form4-insider-trades:ROLLING";
const TIME_BUDGET_MS = 240_000;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = hourBucketKey("sec-form4-insider-trades");
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: 0, batchSize: 0, checkpointBefore: before });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  let cursor = before?.lastSymbol ?? null;
  try {
    const result = await runSecForm4IngestBatch({ afterTicker: cursor, timeBudgetMs: TIME_BUDGET_MS });
    // reachedEnd this cycle -> wrap for tomorrow's run (same as cloud-etf-price's wrap-around cursor)
    cursor = result.stoppedReason === "EXHAUSTED" ? null : result.lastCursor;
    const after = { lastSymbol: cursor, processed: (before?.processed ?? 0) + result.issuersProcessed, succeeded: (before?.succeeded ?? 0) + result.rowsInserted, failed: before?.failed ?? 0, updatedAt: new Date().toISOString() };
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, after);
    await finishRun(runId, JOB, PROVIDER, started, {
      status: "COMPLETED", attempted: result.issuersProcessed, completed: result.issuersProcessed, inserted: result.rowsInserted, updated: 0, failed: 0, retryableFailures: 0,
      checkpointAfter: after, details: { filingsFetched: result.filingsFetched, stoppedReason: result.stoppedReason },
    });
    return Response.json({ ok: true, job: JOB, ...result, runtimeMs: Date.now() - started });
  } catch (e) {
    const blocked = e instanceof Error && e.message.startsWith("SEC_BLOCKED_");
    await finishRun(runId, JOB, PROVIDER, started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: blocked ? 0 : 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message, blocked }, { status: blocked ? 403 : 500 });
  }
}
