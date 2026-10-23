// 2026-10-23（使用者核准）: 2026-10-23 03:04-05:25 UTC連線池唯讀事故（Postgres 25006）發生時，
// 沒有任何東西主動告警，要等到隔天00:30的daily-health-report才會發現，中間超過2小時所有寫入
// 排程全部默默失敗。這支route每15分鐘用正式App自己的DATABASE_URL（跟其他cron job走同一條
// 連線路徑，這樣才能真正測到同樣的問題）對write_probe_heartbeat這張專用小表做一次真實UPDATE
// （migrations/20261023_write_probe_heartbeat.sql，已RLS+REVOKE anon/authenticated）。任何
// 寫入錯誤（不只25006，任何錯誤）都立刻透過既有的lib/daily-health-report/notify.ts送Telegram
// 通知，並寫一筆FAILED的production_scheduler_runs，讓daily-health-report（WRITE_PROBE已加進
// RUN_LOG_PIPELINES）也能抓到、分類成SYSTEM。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { notifyAnomaly } from "@/lib/daily-health-report/notify";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const JOB = "WRITE_PROBE";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();

  // 每15分鐘都是新的run_key，不用dayBucket/hourBucket，直接用整個timestamp──這支route本身很
  // 便宜（一次UPDATE），沒有「同一小時內重複觸發浪費資源」的問題需要防護。
  const runKey = `write-probe:${new Date().toISOString()}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "INTERNAL_WRITE_PROBE", runKey,
    universeCount: 1, batchSize: 1, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  try {
    const updated = await prisma.$executeRawUnsafe(
      `UPDATE write_probe_heartbeat SET last_write_at = now(), counter = counter + 1 WHERE id = 'singleton'`,
    );
    if (updated !== 1) throw new Error(`WRITE_PROBE_UNEXPECTED_ROWCOUNT:${updated}`);

    await finishRun(runId, JOB, "INTERNAL_WRITE_PROBE", startedMs, {
      status: "COMPLETED", attempted: 1, completed: 1, inserted: 0, updated: 1, failed: 0, retryableFailures: 0,
      checkpointAfter: null, details: {},
    });
    return Response.json({ ok: true, job: JOB, runId, status: "COMPLETED" });
  } catch (e: any) {
    const errorMessage = String(e?.message ?? e);
    const notifyResult = await notifyAnomaly(
      `🔴 WRITE_PROBE失敗（${new Date().toISOString()}）：正式環境資料庫寫入測試失敗，可能是連線池唯讀事故重演。\n錯誤：${errorMessage}`,
    );
    await finishRun(runId, JOB, "INTERNAL_WRITE_PROBE", startedMs, {
      status: "FAILED", attempted: 1, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 0,
      error: errorMessage, checkpointAfter: null,
      details: { notify: notifyResult },
    });
    return Response.json({ ok: false, job: JOB, runId, status: "FAILED", error: errorMessage, notify: notifyResult }, { status: 502 });
  }
}
