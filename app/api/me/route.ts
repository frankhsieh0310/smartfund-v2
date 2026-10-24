import {
  AuthenticatedUserConflictError,
  getAccountForRequest,
} from "@/lib/auth/userService";
import { getAuthenticatedSupabaseUser } from "@/lib/auth/supabaseAuth";
import { createSupabaseAdminClient } from "@/lib/auth/supabaseAdmin";
import { prisma } from "@/lib/prisma";

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
// 查證 users 表實際的外鍵（information_schema，不是只看schema.prisma，確認DB層真正的行為）：
// CASCADE（刪User自動清掉，不用手動處理）：alert_rules_p0(owner_user_id)、alerts、audit_logs、
//   favorites、investor_questionnaires、memberships(app_user_id)、notification_profiles、
//   notifications、portfolios、profiles、saved_filters、strategies、strategy_favorites、
//   user_criteria、watchlists(owner_user_id，連帶cascade watchlist_items)、workspaces。
// RESTRICT（Postgres會直接拒絕刪User，必須手動先清掉，這是這次500的根因）：
//   alert_rule_versions(created_by)、watchlist_membership_events(actor_user_id)。
// SET NULL（刪User不會報錯，但資料列會留下、只是user_id被清空——不符合「所有關聯資料都要刪除
//   乾淨」的要求，這裡改成直接刪除整列，不留孤兒資料）：compare_sessions、search_logs。
// 沒有推播裝置（push device）表可清——schema裡沒有這張表，確認過不是漏掉。
async function deleteAllUserData(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.$executeRaw`DELETE FROM watchlist_membership_events WHERE actor_user_id = ${userId}`,
    prisma.$executeRaw`DELETE FROM alert_rule_versions WHERE created_by = ${userId}`,
    prisma.$executeRaw`DELETE FROM compare_sessions WHERE user_id = ${userId}`,
    prisma.$executeRaw`DELETE FROM search_logs WHERE user_id = ${userId}`,
    prisma.user.delete({ where: { id: userId } }), // 其餘CASCADE關聯表都在這一步自動清乾淨
  ]);
}

export async function DELETE(request: Request) {
  const identity = await getAuthenticatedSupabaseUser(request);
  if (!identity) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await prisma.user.findUnique({ where: { supabaseId: identity.id } });

  if (dbUser) {
    try {
      await deleteAllUserData(dbUser.id);
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
