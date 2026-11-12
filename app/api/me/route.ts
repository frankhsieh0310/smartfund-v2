import {
  AuthenticatedUserConflictError,
  getAccountForRequest,
} from "@/lib/auth/userService";
import { getAuthenticatedSupabaseUser } from "@/lib/auth/supabaseAuth";
import { createSupabaseAdminClient } from "@/lib/auth/supabaseAdmin";
import { prisma } from "@/lib/prisma";
import { deleteUserDataCascade } from "@/lib/auth/deleteUserCascade";

export async function GET(request: Request) {
  try {
    const account = await getAccountForRequest(request);

    if (!account) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    return Response.json(account, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof AuthenticatedUserConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }

    console.error("GET /api/me failed", error);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// Account deletion. 2026-10-24（使用者核准定案，App Store審查/個資法硬性要求，最優先）:
// 順序整個反過來——先在單一交易內刪光DB裡這個使用者的所有資料，交易成功之後才刪Supabase登入
// 身分，絕不能再出現「登入身分刪了、DB資料還在」的狀態（舊版就是這樣，先刪auth再刪DB，DB那步
// 失敗就會卡在這個狀態）。DB交易任何一步失敗就整個回復（Prisma $transaction自動rollback），
// 回傳錯誤、不動登入身分——使用者可以直接重試。
//
// 2026-11-12 使用者核准修正：原本手動列的刪除清單沒有包含public.forum_*（論壇功能，跟台股拼圖
// 自己的twapp.forum_*是兩套獨立的表）——VERIFIED查pg_constraint，forum_posts/forum_replies/
// forum_reports/forum_blocks/forum_admins/forum_tos_acceptances全部用NO ACTION擋刪除，使用者
// 若發過論壇文章，原本這支route會直接500失敗。改用共用的deleteUserDataCascade（跟每日殘留清理
// 排程cleanup-qa-leftover-user同一套邏輯，見lib/auth/deleteUserCascade.ts），含正確的刪除順序
// （先清自己文章的回覆跟別人對自己文章的回覆，再刪文章本身）。
export async function DELETE(request: Request) {
  const identity = await getAuthenticatedSupabaseUser(request);
  if (!identity) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await prisma.user.findUnique({ where: { supabaseId: identity.id } });

  if (dbUser) {
    try {
      await deleteUserDataCascade(dbUser.id);
    } catch (error) {
      // 交易自動rollback——這個使用者的資料跟登入身分都還在，沒有任何改變，可以直接重試。
      console.error("DELETE /api/me: failed to delete user data, nothing was changed", error);
      return Response.json({ error: "Failed to delete account data; nothing was changed. Please try again." }, { status: 500 });
    }
  }

  // DB資料已經確認刪乾淨（或本來就沒有），這時候才刪登入身分。
  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin.auth.admin.deleteUser(identity.id);
    if (error) throw error;
  } catch (error) {
    // 資料已經刪乾淨，只剩登入身分還在——可以直接重試這支route：dbUser這時候已經找不到了，
    // 會跳過上面的DB交易，直接再試一次刪登入身分，是安全的。
    console.error("DELETE /api/me: user data deleted but Supabase auth identity delete failed", error);
    return Response.json({ error: "Your data was deleted, but removing your sign-in failed. Please try deleting your account again." }, { status: 500 });
  }

  // Not a 204: the shared mobile API client always parses the response body as JSON, which
  // throws on an empty 204 body.
  return Response.json({ ok: true });
}
