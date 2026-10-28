// 一次性清除上一輪 QA 測試帳號殘留的 User 列與關聯資料（2026-10-28，使用者核准範圍：改成由
// 排程/部署流程執行，不准用本機腳本直接寫正式資料庫）。邏輯跟 scripts/cleanup-qa-leftover-user.mjs
// （commit 41339d367，從未執行過）完全一致，只是換成 write-gated cron 的形式執行。
// 寫死單一 userId（Supabase 登入身分已刪除，只剩 DB 資料殘留），刪除順序：先刪兩個會擋刪除的
// RESTRICT 關聯，再刪兩個會留孤兒資料的 SET NULL 關聯，最後刪 User 本身（其餘關聯是 CASCADE）。
// 全部包在一個交易裡。shadow mode 預設關閉，同一套 production_scheduler_runs 慣例。
// 這是一次性工作：User 已經不存在時直接回報 SKIPPED，之後這支 route 保留著也不會再做任何事。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const JOB = "CLEANUP_QA_LEFTOVER_USER";
const USER_ID = "8d48e1a9-0819-498c-91fe-8722fa46f2f3";

function isWriteEnabled(): boolean {
  return process.env.CLEANUP_QA_LEFTOVER_USER_WRITE?.trim() === "on";
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const writeEnabled = isWriteEnabled();
  const runKey = `cleanup-qa-leftover-user:once`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "INTERNAL", runKey, universeCount: 1, batchSize: 1, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "already completed once" });

  try {
    const before = await prisma.$queryRawUnsafe<Array<{ id: string; email: string }>>(`SELECT id, email FROM users WHERE id = $1`, USER_ID);
    if (before.length === 0) {
      await finishRun(runId, JOB, "INTERNAL", startedMs, { status: "SKIPPED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0, checkpointAfter: null, details: { reason: "already deleted" } });
      return Response.json({ ok: true, job: JOB, status: "SKIPPED", reason: "user already deleted" });
    }
    if (!writeEnabled) {
      await finishRun(runId, JOB, "INTERNAL", startedMs, { status: "SKIPPED", attempted: 1, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0, checkpointAfter: null, details: { writeEnabled, found: before[0] } });
      return Response.json({ ok: true, job: JOB, status: "SHADOW", writeEnabled, found: before[0] });
    }

    await prisma.$transaction([
      prisma.$executeRaw`DELETE FROM watchlist_membership_events WHERE actor_user_id = ${USER_ID}`,
      prisma.$executeRaw`DELETE FROM alert_rule_versions WHERE created_by = ${USER_ID}`,
      prisma.$executeRaw`DELETE FROM compare_sessions WHERE user_id = ${USER_ID}`,
      prisma.$executeRaw`DELETE FROM search_logs WHERE user_id = ${USER_ID}`,
      prisma.user.delete({ where: { id: USER_ID } }),
    ]);

    const after = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM users WHERE id = $1`, USER_ID);
    const ok = after.length === 0;
    await finishRun(runId, JOB, "INTERNAL", startedMs, { status: ok ? "COMPLETED" : "FAILED", attempted: 1, completed: ok ? 1 : 0, inserted: 0, updated: 0, failed: ok ? 0 : 1, retryableFailures: 0, checkpointAfter: null, details: { writeEnabled, deleted: before[0], verifiedGone: ok } });
    return Response.json({ ok, job: JOB, status: ok ? "COMPLETED" : "FAILED", deleted: before[0] });
  } catch (e) {
    const message = (e as Error).message;
    await finishRun(runId, JOB, "INTERNAL", startedMs, { status: "FAILED", attempted: 1, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 0, error: message, checkpointAfter: null, details: {} });
    return Response.json({ ok: false, job: JOB, error: message }, { status: 500 });
  }
}
