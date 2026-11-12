// 2026-11-12 使用者核准（帳號刪除/殘留清理定案）: 刪除 smartfund-v2 自己 `users` 表某一列時，
// 真正清空底下所有資料（不留SET NULL孤兒列，蘋果規定帳號刪除必須真的刪除資料）。
//
// VERIFIED（直接查production的pg_constraint，不是憑印象猜的）：指向 public.users(id) 的FK
// 一共27個，分三類：
//   - CASCADE（'c'）：favorites/portfolios/strategies/user_criteria/watchlists/workspaces/
//     notifications/notification_profiles/alerts/audit_logs/investor_questionnaires/
//     saved_filters/strategy_favorites——刪users列時Postgres自己連鎖刪除，這裡不用手動處理。
//   - SET NULL（'n'）：compare_sessions.user_id、search_logs.user_id——預設只會留孤兒列（user_id
//     變null），不是真的刪除，這裡改成明確DELETE，符合「真的刪除資料」的要求。
//   - RESTRICT/NO ACTION（'r'/'a'）：擋刪除，要手動先清掉，否則整筆交易會失敗：
//     alert_rule_versions.created_by、watchlist_membership_events.actor_user_id、
//     以及一組意外發現的「public.forum_*」論壇功能（forum_posts/forum_replies/forum_reports/
//     forum_blocks/forum_admins/forum_tos_acceptances——跟台股拼圖自己的twapp.forum_*是兩套
//     完全獨立的表，不要混淆）。forum_replies.post_id→forum_posts也是NO ACTION，所以刪除順序
//     是：先清自己發出的回覆/別人對自己文章的回覆，再刪自己的文章，最後刪封鎖/管理者/ToS同意
//     紀錄——跟台股拼圖deleteAccount.ts的論壇刪除順序是同一個邏輯，只是換一套表名。
import { prisma } from "@/lib/prisma";

export type DeleteUserCascadeSummary = {
  userId: string;
  email: string;
  deletedCounts: Record<string, number>;
};

/** 刪除一個使用者在smartfund-v2本身資料庫裡的所有資料（不含Supabase登入帳號本身——由呼叫端
 * 決定要不要、何時刪登入帳號）。呼叫前請先確認 userId 真的要刪，這個函式本身不做確認。 */
export async function deleteUserDataCascade(userId: string): Promise<DeleteUserCascadeSummary | null> {
  const before = await prisma.$queryRawUnsafe<Array<{ id: string; email: string }>>(`SELECT id, email FROM users WHERE id = $1`, userId);
  if (!before.length) return null;
  const email = before[0].email;

  const counts: Record<string, number> = {};
  const run = async (label: string, sql: string) => {
    const n = await prisma.$executeRawUnsafe(sql, userId);
    counts[label] = n;
  };

  await prisma.$transaction(async (tx) => {
    const runTx = async (label: string, sql: string) => {
      const n = await tx.$executeRawUnsafe(sql, userId);
      counts[label] = n;
    };
    // RESTRICT/NO ACTION 關聯：必須先清，否則刪users列會失敗。
    await runTx("forum_replies_on_own_posts", `DELETE FROM forum_replies WHERE post_id IN (SELECT id FROM forum_posts WHERE author_user_id = $1)`);
    await runTx("forum_replies_authored", `DELETE FROM forum_replies WHERE author_user_id = $1`);
    await runTx("forum_posts", `DELETE FROM forum_posts WHERE author_user_id = $1`);
    await runTx("forum_reports", `DELETE FROM forum_reports WHERE reporter_user_id = $1`);
    await runTx("forum_blocks", `DELETE FROM forum_blocks WHERE blocker_user_id = $1 OR blocked_user_id = $1`);
    await runTx("forum_admins", `DELETE FROM forum_admins WHERE user_id = $1`);
    await runTx("forum_tos_acceptances", `DELETE FROM forum_tos_acceptances WHERE user_id = $1`);
    await runTx("alert_rule_versions", `DELETE FROM alert_rule_versions WHERE created_by = $1`);
    await runTx("watchlist_membership_events", `DELETE FROM watchlist_membership_events WHERE actor_user_id = $1`);
    // SET NULL 關聯：改成明確刪除（不留孤兒列），符合「真的刪除」要求。
    await runTx("compare_sessions", `DELETE FROM compare_sessions WHERE user_id = $1`);
    await runTx("search_logs", `DELETE FROM search_logs WHERE user_id = $1`);
    // 最後刪users本身——其餘CASCADE關聯（favorites/portfolios/strategies/user_criteria/
    // watchlists/workspaces/notifications/notification_profiles/alerts/audit_logs/
    // investor_questionnaires/saved_filters/strategy_favorites）由Postgres自動連鎖刪除。
    await tx.$executeRawUnsafe(`DELETE FROM users WHERE id = $1`, userId);
    const verify = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM users WHERE id = $1`, userId);
    if (verify.length) throw new Error(`delete verify failed for user ${userId}`);
  });

  const after = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM users WHERE id = $1`, userId);
  if (after.length) throw new Error(`post-commit verify failed for user ${userId}`);

  return { userId, email, deletedCounts: counts };
}
