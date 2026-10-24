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
//      job_id='QA_TEST_ACCOUNT_LIFECYCLE' 的建立成功紀錄（連同建立出來的 userId 一起存在
//      validation_details），之後任何呼叫都先用 admin.auth.admin.getUserById(userId) 真的查一次
//      這個帳號還在不在——Supabase 的 generateLink(type:'magiclink') 對不存在的 email 會「靜默
//      建立一個新帳號」，不會回錯誤，所以不能只看「這個 email 以前建立過」就直接重發連結，一定
//      要先確認底層帳號沒被「刪除帳號」流程刪掉。帳號已經不在了，一律410，不再自動建立第二個。
//      2026-10-24（獨立驗收代理發現，使用者核准修正）: 原本這裡的程式碼只有註解寫了「一律
//      410」，從來沒有真的實作這個查核，造成刪除帳號後再呼叫會靜默建出一個新帳號——已修正。
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

  const already = await prisma.$queryRawUnsafe<{ validation_details: { userId?: string } | null }[]>(
    `SELECT validation_details FROM production_scheduler_runs WHERE job_id = $1 LIMIT 1`,
    LIFECYCLE_JOB_ID,
  );
  const hadPriorRun = already.length > 0;
  const existingUserId = already[0]?.validation_details?.userId ?? null;

  try {
    if (hadPriorRun && !existingUserId) {
      // 舊版（這次修正之前）寫的那筆紀錄沒有存userId，沒辦法直接查這個帳號是不是還在——用
      // listUsers掃一次這個固定email現在是不是真的還有對應帳號，順便把結果補回
      // validation_details，這個分支只會在這次修正後第一次呼叫時跑到，之後就都走上面
      // 有userId可查的正常路徑。
      const { data: list, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (listError) return Response.json({ error: `LIST_USERS_FAILED: ${listError.message}` }, { status: 500 });
      const foundUser = list.users.find((u) => u.email === QA_EMAIL);
      if (!foundUser) {
        // 真的不在了——視同已刪除，一律410，不自動建立新帳號。
        await prisma.$executeRawUnsafe(
          `UPDATE production_scheduler_runs SET validation_details = $1::jsonb WHERE job_id = $2`,
          JSON.stringify({ userId: null, backfilledAt: new Date().toISOString(), note: "舊帳號已不存在，等使用者下次核准才會再建立" }),
          LIFECYCLE_JOB_ID,
        );
        return Response.json({ error: "QA_TEST_ACCOUNT_ALREADY_DELETED" }, { status: 410 });
      }
      await prisma.$executeRawUnsafe(
        `UPDATE production_scheduler_runs SET validation_details = $1::jsonb WHERE job_id = $2`,
        JSON.stringify({ userId: foundUser.id, backfilledAt: new Date().toISOString() }),
        LIFECYCLE_JOB_ID,
      );
      const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: QA_EMAIL });
      if (linkError || !link) return Response.json({ error: `GENERATE_LINK_FAILED: ${linkError?.message}` }, { status: 500 });
      return Response.json({
        userId: foundUser.id,
        hashedToken: link.properties.hashed_token,
        note: "帳號已建立過，這次只重發一次性登入連結（沒有再次建立帳號，並補回遺失的追蹤資料）。",
      });
    }

    if (hadPriorRun && existingUserId) {
      const { data: stillExists, error: lookupError } = await admin.auth.admin.getUserById(existingUserId);
      if (lookupError || !stillExists?.user) {
        // 帳號已經被「刪除帳號」流程刪掉了——這是條件3明確要求的終態，一律410，絕對不能再呼叫
        // generateLink，否則 Supabase 會對這個 email 靜默建出一個新帳號。
        return Response.json({ error: "QA_TEST_ACCOUNT_ALREADY_DELETED" }, { status: 410 });
      }
      const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: QA_EMAIL });
      if (linkError || !link) return Response.json({ error: `GENERATE_LINK_FAILED: ${linkError?.message}` }, { status: 500 });
      return Response.json({
        userId: existingUserId,
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
      `INSERT INTO production_scheduler_runs (id, job_id, exchange, run_type, status, started_at, completed_at, attempted, completed, inserted, updated, failed, validation_details)
       VALUES (gen_random_uuid()::text, $1, 'N/A', 'QA_TEST_ACCOUNT', 'COMPLETED', NOW(), NOW(), 1, 1, 1, 0, 0, $2::jsonb)`,
      LIFECYCLE_JOB_ID,
      JSON.stringify({ userId }),
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
