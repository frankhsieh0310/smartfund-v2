// 2026-10-28：原本一次性清除上一輪QA測試帳號殘留的User列（寫死單一userId）。
// 2026-11-12（使用者核准，帳號刪除殘留清理定案）: 改成通用版——台股拼圖跟全球投資夥伴共用同一個
// Supabase登入帳號，使用者在台股拼圖刪除帳號會把共用的登入帳號（auth.users）整個刪掉，但VERIFIED
// （查production的pg_trigger/information_schema）全球投資夥伴自己的users表跟auth.users之間
// 完全沒有FK或trigger，登入帳號被刪掉不會自動清掉這邊的資料，會變成「殘留孤兒」：users.supabase_id
// 對應不到任何auth.users列。這支改成每次掃描全部users、找出supabase_id已經查無對應auth.users的
// 殘留列，底下資料一併刪除（刪除邏輯見lib/auth/deleteUserCascade.ts，含論壇/集中度等RESTRICT
// 關聯的正確處理順序）。
// 沿用同一個CLEANUP_QA_LEFTOVER_USER_WRITE開關、同一支既有排程（0 */6 * * *），沒有新增排程。
// shadow mode（開關關閉時）只回報找到幾筆、是哪些email，不刪除——第一次要先讓使用者看過這份
// 名單、核准後才打開開關。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { deleteUserDataCascade } from "@/lib/auth/deleteUserCascade";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "CLEANUP_ORPHANED_USERS";
const MAX_PER_RUN = 50; // 保險上限，避免單次invocation處理量失控；目前規模（個位數~十位數）遠低於此
// 2026-11-12 使用者核准定案：單次要刪的殘留帳號超過這個數字就整批停止不刪——這是防止「登入服務
// 暫時查不到／連線異常」導致EXISTS判斷大量誤判成「已刪除」而真的把正常會員資料清掉的安全網，跟
// 下面查詢本身的timeout防呆是兩道獨立的保險（查詢真的失敗/逾時那道已經會讓整批直接不刪，這道
// 專門防「查詢沒報錯、但回傳結果異常地多」這種更隱性的情境）。
const MAX_DELETE_PER_RUN_SAFETY = 5;
const ORPHAN_QUERY_TIMEOUT_MS = 8_000;

function isWriteEnabled(): boolean {
  return process.env.CLEANUP_QA_LEFTOVER_USER_WRITE?.trim() === "on";
}
// 2026-11-12 使用者核准定案：查詢auth.users是否還存在失敗或逾時，一律當作「帳號還在」不刪
// ——寧可這輪漏刪、留到下一輪自然重試，也不要在查詢本身不可靠的狀況下誤刪真實會員資料。
async function findOrphanedUsers(limit: number): Promise<{ rows: Array<{ id: string; email: string; created_at: Date }>; queryFailed: boolean }> {
  try {
    const rows = await Promise.race([
      prisma.$queryRawUnsafe<Array<{ id: string; email: string; created_at: Date }>>(
        `SELECT u.id, u.email, u.created_at FROM users u
          WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.supabase_id::uuid)
          ORDER BY u.created_at ASC LIMIT $1`,
        limit,
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ORPHAN_QUERY_TIMEOUT")), ORPHAN_QUERY_TIMEOUT_MS)),
    ]);
    return { rows, queryFailed: false };
  } catch {
    return { rows: [], queryFailed: true };
  }
}
function inForbiddenWindowTaipei(): boolean {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).find((p) => p.type === "hour")?.value ?? "12");
  return h >= 1 && h < 6;
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  if (inForbiddenWindowTaipei()) {
    return Response.json({ ok: false, job: JOB, skipped: true, reason: "FORBIDDEN_WINDOW_01_0530_TAIPEI" });
  }
  const startedMs = Date.now();
  const writeEnabled = isWriteEnabled();
  const runKey = `cleanup-orphaned-users:${new Date().toISOString().slice(0, 13)}`; // 同一小時內重觸發直接視為重複
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "INTERNAL", runKey, universeCount: 0, batchSize: MAX_PER_RUN, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "double trigger this hour" });

  try {
    // Step 1（三道保護第一步）：先讀出目前有哪些user.supabase_id在auth.users裡已經找不到對應列。
    const { rows: orphans, queryFailed } = await findOrphanedUsers(MAX_PER_RUN);

    if (queryFailed) {
      await finishRun(runId, JOB, "INTERNAL", startedMs, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 1, checkpointAfter: null, error: "orphan check query failed or timed out — treating as no orphans this run, nothing deleted", details: { writeEnabled } });
      return Response.json({ ok: false, job: JOB, status: "QUERY_FAILED_NOTHING_DELETED", writeEnabled });
    }

    if (!writeEnabled) {
      await finishRun(runId, JOB, "INTERNAL", startedMs, { status: "SKIPPED", attempted: orphans.length, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0, checkpointAfter: null, details: { writeEnabled, foundCount: orphans.length, found: orphans.map((o) => ({ id: o.id, email: o.email })) } });
      return Response.json({ ok: true, job: JOB, status: "SHADOW", writeEnabled, foundCount: orphans.length, found: orphans.map((o) => ({ id: o.id, email: o.email, createdAt: o.created_at })) });
    }

    // 安全網：單次要刪的筆數超過MAX_DELETE_PER_RUN_SAFETY就整批不刪，只回報、等人工確認——
    // 避免登入服務暫時異常導致EXISTS大量誤判、一次清掉一大批正常會員資料。
    if (orphans.length > MAX_DELETE_PER_RUN_SAFETY) {
      await finishRun(runId, JOB, "INTERNAL", startedMs, { status: "FAILED", attempted: orphans.length, completed: 0, inserted: 0, updated: 0, failed: orphans.length, retryableFailures: 0, checkpointAfter: null, error: `NEEDS_REVIEW: found ${orphans.length} orphaned users, exceeds safety cap of ${MAX_DELETE_PER_RUN_SAFETY} — nothing deleted, needs manual review`, details: { writeEnabled, foundCount: orphans.length, found: orphans.map((o) => ({ id: o.id, email: o.email })) } });
      return Response.json({ ok: false, job: JOB, status: "NEEDS_REVIEW_TOO_MANY", writeEnabled, foundCount: orphans.length, cap: MAX_DELETE_PER_RUN_SAFETY, found: orphans.map((o) => ({ id: o.id, email: o.email, createdAt: o.created_at })) });
    }

    const deleted: Array<{ id: string; email: string; deletedCounts: Record<string, number> }> = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const o of orphans) {
      try {
        const result = await deleteUserDataCascade(o.id);
        if (result) deleted.push({ id: result.userId, email: result.email, deletedCounts: result.deletedCounts });
      } catch (e) {
        failed.push({ id: o.id, error: (e as Error).message });
      }
    }

    await finishRun(runId, JOB, "INTERNAL", startedMs, {
      status: failed.length ? "PARTIAL" : "COMPLETED", attempted: orphans.length, completed: deleted.length, inserted: 0, updated: 0, failed: failed.length, retryableFailures: 0, checkpointAfter: null,
      details: { writeEnabled, deleted, failed },
    });
    return Response.json({ ok: failed.length === 0, job: JOB, status: failed.length ? "PARTIAL" : "COMPLETED", deletedCount: deleted.length, deleted, failed });
  } catch (e) {
    const message = (e as Error).message;
    await finishRun(runId, JOB, "INTERNAL", startedMs, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 0, error: message, checkpointAfter: null, details: {} });
    return Response.json({ ok: false, job: JOB, error: message }, { status: 500 });
  }
}
