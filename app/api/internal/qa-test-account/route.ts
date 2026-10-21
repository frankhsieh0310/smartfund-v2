// 2026-10-21（14點任務第4/5/6/8項，使用者核准的臨時Preview專用route）: 用伺服器端已設定的
// SUPABASE_SERVICE_ROLE_KEY建立/重用唯一一個寫死email的QA測試帳號，回傳一次性magic-link OTP
// token（不是密碼，不是service role key本身），讓測試端用anon key呼叫
// supabase.auth.verifyOtp()換取真實session登入。金鑰本身永遠不離開這支route的伺服器端執行環境
// ——不回傳、不印出、不寫入任何log/commit。
//
// 只能建立這一個寫死的email，不接受任何輸入參數改變這一點。只部署到Preview，測試完成後這支
// route本身跟它所在的臨時分支/Preview部署都要刪除（見CLAUDE.md「測試帳號建立方式」那條）。
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QA_EMAIL = "smartmatch-qa-20261021@example.com" as const;

function isAuthorized(request: Request): boolean {
  const secret = process.env.LOCAL_SCHEDULE_REPORT_SECRET;
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

  try {
    // 先直接嘗試建立這個寫死的email；如果之前測試已經建立過，會失敗，再查既有帳號重用，不重複建立。
    let userId: string | null = null;
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: QA_EMAIL,
      email_confirm: true,
      user_metadata: { qa_test_account: true, created_for: "14-point-task-2026-10-21" },
    });

    if (createError) {
      // 已存在就查出既有的 user id 重用，不是錯誤。
      if (createError.message.toLowerCase().includes("already") || createError.status === 422) {
        const { data: page1, error: page1Error } = await admin.auth.admin.listUsers({ perPage: 1000, page: 1 });
        if (page1Error) return Response.json({ error: `LOOKUP_EXISTING_FAILED: ${page1Error.message}` }, { status: 500 });
        const existing = page1.users.find((u) => u.email === QA_EMAIL);
        if (!existing) return Response.json({ error: "CREATE_FAILED_AND_NOT_FOUND", detail: createError.message }, { status: 500 });
        userId = existing.id;
      } else {
        return Response.json({ error: `CREATE_USER_FAILED: ${createError.message}` }, { status: 500 });
      }
    } else {
      userId = created.user.id;
    }

    const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: QA_EMAIL });
    if (linkError || !link) return Response.json({ error: `GENERATE_LINK_FAILED: ${linkError?.message}` }, { status: 500 });

    return Response.json({
      userId,
      email: QA_EMAIL,
      hashedToken: link.properties.hashed_token,
      note: "用 anon key 呼叫 supabase.auth.verifyOtp({ token_hash: hashedToken, type: 'email' }) 換取真實 session，這個 token 用過一次或過期後就失效。",
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "UNKNOWN_ERROR" }, { status: 500 });
  }
}
