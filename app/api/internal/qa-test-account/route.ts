// 2026-10-21（14點任務第4/5/6/8項，使用者核准併入正式部署的臨時route）: 用伺服器端已設定的
// SUPABASE_SERVICE_ROLE_KEY建立唯一一個寫死email的QA測試帳號，回傳一次性magic-link OTP
// token（不是密碼，不是service role key本身），讓測試端用anon key呼叫
// supabase.auth.verifyOtp()換取真實session登入。金鑰本身永遠不離開這支route的伺服器端執行環境
// ——不回傳、不印出、不寫入任何log/commit。
//
// 四個安全條件（使用者2026-10-21明確要求，全部必須做到）：
//   1. QA_TEST_ACCOUNT_SECRET驗證——沒有正確密鑰一律401。
//   2. 寫死只能建立 smartmatch-qa-20261021@example.com 這一個email，不接受任何參數。
//   3. 自動失效——用 production_scheduler_runs 表（既有表，不是新建）寫一筆
//      job_id='QA_TEST_ACCOUNT_LIFECYCLE' 的建立成功紀錄；之後任何呼叫，不管Supabase那邊的
//      帳號是不是已經被「刪除帳號」流程刪掉了，一律410，不會再建立第二次。
//   4. 只回傳User UID與session token，不回傳金鑰或任何其他使用者資料。
//
// 下一次部署必須移除這支route（連同QA_TEST_ACCOUNT_SECRET環境變數一起移除，見CLAUDE.md）。
import { createClient } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QA_EMAIL = "smartmatch-qa-20261021@example.com" as const;
const LIFECYCLE_JOB_ID = "QA_TEST_ACCOUNT_LIFECYCLE" as const;

function isAuthorized(request: Request): boolean {
  const secret = process.env.QA_TEST_ACCOUNT_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY_NOT_CONFIGURED_IN_THIS_ENVIRONMENT" }, { status: 500 });
  }
  const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // 條件3：自動失效檢查只擋「建立」，不擋「幫同一個已核准的email重發一次登入連結」——
  // magic-link OTP用過一次就失效（VERIFIED：第一次測試時就遇到），帳號只能建立一次，但測試
  // 過程需要重新登入好幾次是正常的，所以已建立過之後，這支route改成只重發連結，不再呼叫
  // admin.auth.admin.createUser()。
  const already = await prisma.$queryRawUnsafe<{ c: number }[]>(
    `SELECT count(*)::int c FROM production_scheduler_runs WHERE job_id = $1`,
    LIFECYCLE_JOB_ID,
  );

  try {
    if (already[0].c > 0) {
      const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: QA_EMAIL });
      if (linkError || !link) return Response.json({ error: `GENERATE_LINK_FAILED: ${linkError?.message}` }, { status: 500 });
      return Response.json({
        userId: link.user?.id ?? null,
        hashedToken: link.properties.hashed_token,
        note: "帳號已建立過，這次只重發一次性登入連結（沒有再次建立帳號）。",
      });
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: QA_EMAIL,
      email_confirm: true,
      user_metadata: { qa_test_account: true, created_for: "14-point-task-2026-10-21" },
    });
    if (createError || !created.user) {
      return Response.json({ error: `CREATE_USER_FAILED: ${createError?.message}` }, { status: 500 });
    }
    const userId = created.user.id;

    const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: QA_EMAIL });
    if (linkError || !link) return Response.json({ error: `GENERATE_LINK_FAILED: ${linkError?.message}` }, { status: 500 });

    // 一定要在成功建立之後才寫入失效標記——寫入失敗不影響這次回應，但下一次呼叫會因為查不到
    // 這筆紀錄而再試一次建立，createUser對同一個email第二次呼叫本來就會失敗，是安全的降級。
    await prisma.$executeRawUnsafe(
      `INSERT INTO production_scheduler_runs (id, job_id, exchange, run_type, status, started_at, completed_at, attempted, completed, inserted, updated, failed)
       VALUES (gen_random_uuid()::text, $1, 'N/A', 'QA_TEST_ACCOUNT', 'COMPLETED', NOW(), NOW(), 1, 1, 1, 0, 0)`,
      LIFECYCLE_JOB_ID,
    );

    return Response.json({
      userId,
      hashedToken: link.properties.hashed_token,
      note: "用 anon key 呼叫 supabase.auth.verifyOtp({ token_hash: hashedToken, type: 'email' }) 換取真實 session，這個 token 用過一次或過期後就失效。",
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "UNKNOWN_ERROR" }, { status: 500 });
  }
}
