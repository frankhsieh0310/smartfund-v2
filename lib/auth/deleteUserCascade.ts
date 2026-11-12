// 2026-11-12 使用者核准（帳號刪除/殘留清理定案）: 刪除 smartfund-v2 自己 `users` 表某一列時，
// 真正清空底下所有資料（不留SET NULL孤兒列，蘋果規定帳號刪除必須真的刪除資料）。
//
// VERIFIED（直接查production的pg_constraint，BFS走過從users出發的整張FK圖，不是只看直接掛在
// users底下那一層——這支原本漏掉兩層深的RESTRICT，導致正式環境排程每6小時都刪不掉一筆殘留帳號，
// 2026-11-12發現並補完整）：
//   - CASCADE（'c'）：favorites/portfolios/strategies/user_criteria/watchlists/workspaces/
//     notifications/notification_profiles/alerts/audit_logs/investor_questionnaires/
//     saved_filters/strategy_favorites/alert_rules_p0，以及它們底下再連鎖的子表（portfolio_*、
//     strategy_*、criteria_*、watchlist_items、workspace_*、alert_occurrence_events等）——刪
//     users列時Postgres自己連鎖刪除，這裡不用手動處理，除非被下面的RESTRICT卡住。
//   - SET NULL（'n'）：compare_sessions.user_id、search_logs.user_id——預設只會留孤兒列（user_id
//     變null），不是真的刪除，這裡改成明確DELETE，符合「真的刪除資料」的要求。
//   - RESTRICT/NO ACTION（'r'/'a'）：擋刪除，要先清掉，否則整筆交易會失敗。分兩層：
//     (1) 直接掛在users底下：alert_rule_versions.created_by、watchlist_membership_events.
//         actor_user_id，以及一組「public.forum_*」論壇功能（forum_posts/forum_replies/
//         forum_reports/forum_blocks/forum_admins/forum_tos_acceptances——跟台股拼圖自己的
//         twapp.forum_*是兩套完全獨立的表，不要混淆）。forum_replies.post_id→forum_posts也是
//         NO ACTION，刪除順序：先清自己發出的回覆/別人對自己文章的回覆，再刪自己的文章，最後
//         刪封鎖/管理者/ToS同意紀錄。
//     (2) 2026-11-12新查到、原本漏掉的第二層（擋在CASCADE鏈路中間，Postgres連鎖刪除到一半會
//         被卡住，不是掛在users正下方所以第一次查漏掉）：
//         - alert_occurrences.rule_version_id、alert_rule_states.rule_version_id
//           都RESTRICT指向alert_rule_versions——而alert_rule_versions除了created_by直接掛
//           users，也會被alert_rules_p0（CASCADE自users）的連鎖刪除牽動到，所以要先把這個user
//           名下所有rule（無論是自己建的版本created_by，還是自己擁有的規則owner_user_id底下的
//           版本）對應的occurrences／states都清掉，才能讓alert_rule_versions真正刪得掉。
//           2026-11-12生產環境實測：漏了這條，排程卡在alert_rule_states_rule_version_id_fkey，
//           同一筆測試殘留帳號連續兩輪（00:00、06:00）都刪除失敗。
//         - alert_delivery_attempts.profile_id、alert_delivery_dead_letters.profile_id都
//           RESTRICT指向notification_profiles（CASCADE自users）——同樣要先清掉才能讓
//           notification_profiles的連鎖刪除成功。
//         - portfolio_tax_lots.transaction_id RESTRICT指向portfolio_transactions（CASCADE
//           自portfolios，CASCADE自users）；portfolio_tax_lots自己也有CASCADE自portfolios，
//           但多層cascade在同一筆DELETE語句內的觸發順序不保證安全，所以照其他RESTRICT關聯
//           一樣的做法，用portfolio_id明確先刪掉，不依賴Postgres自己排順序。
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
    // 第二層RESTRICT（擋在alert_rule_versions/notification_profiles的CASCADE鏈路中間，2026-11-12
    // 新補）：先清掉指向這個user名下所有alert rule版本的occurrences/states，alert_rule_versions
    // 才刪得掉（無論是自己建立的版本created_by，還是自己擁有規則owner_user_id底下的版本）。
    await runTx(
      "alert_occurrences_under_user_rules",
      `DELETE FROM alert_occurrences WHERE rule_version_id IN (SELECT id FROM alert_rule_versions WHERE created_by = $1) OR rule_id IN (SELECT id FROM alert_rules_p0 WHERE owner_user_id = $1)`,
    );
    await runTx(
      "alert_rule_states_under_user_rules",
      `DELETE FROM alert_rule_states WHERE rule_version_id IN (SELECT id FROM alert_rule_versions WHERE created_by = $1) OR rule_id IN (SELECT id FROM alert_rules_p0 WHERE owner_user_id = $1)`,
    );
    await runTx("alert_rule_versions", `DELETE FROM alert_rule_versions WHERE created_by = $1`);
    // 第二層RESTRICT：notification_profiles是CASCADE自users，但alert_delivery_attempts/
    // dead_letters的profile_id擋著，要先清掉才能讓notification_profiles真正連鎖刪除成功。
    await runTx(
      "alert_delivery_attempts_under_user_profiles",
      `DELETE FROM alert_delivery_attempts WHERE profile_id IN (SELECT id FROM notification_profiles WHERE user_id = $1)`,
    );
    await runTx(
      "alert_delivery_dead_letters_under_user_profiles",
      `DELETE FROM alert_delivery_dead_letters WHERE profile_id IN (SELECT id FROM notification_profiles WHERE user_id = $1)`,
    );
    await runTx("watchlist_membership_events", `DELETE FROM watchlist_membership_events WHERE actor_user_id = $1`);
    // 第二層RESTRICT：portfolio_tax_lots.transaction_id擋著portfolio_transactions（CASCADE自
    // portfolios）。tax_lots自己也CASCADE自portfolios，但多層cascade在同一筆DELETE語句內的觸發
    // 順序不保證安全，照其他RESTRICT關聯一樣明確先刪，不依賴Postgres自己排順序。
    await runTx(
      "portfolio_tax_lots_under_user_portfolios",
      `DELETE FROM portfolio_tax_lots WHERE portfolio_id IN (SELECT id FROM portfolios WHERE user_id = $1)`,
    );
    // SET NULL 關聯：改成明確刪除（不留孤兒列），符合「真的刪除」要求。
    await runTx("compare_sessions", `DELETE FROM compare_sessions WHERE user_id = $1`);
    await runTx("search_logs", `DELETE FROM search_logs WHERE user_id = $1`);
    // 最後刪users本身——其餘CASCADE關聯（favorites/portfolios/strategies/user_criteria/
    // watchlists/workspaces/notifications/notification_profiles/alerts/audit_logs/
    // investor_questionnaires/saved_filters/strategy_favorites/alert_rules_p0，以及它們底下
    // 再連鎖的子表）由Postgres自動連鎖刪除，上面已經清掉所有會卡住這條鏈路的RESTRICT關聯。
    await tx.$executeRawUnsafe(`DELETE FROM users WHERE id = $1`, userId);
    const verify = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM users WHERE id = $1`, userId);
    if (verify.length) throw new Error(`delete verify failed for user ${userId}`);
  });

  const after = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM users WHERE id = $1`, userId);
  if (after.length) throw new Error(`post-commit verify failed for user ${userId}`);

  return { userId, email, deletedCounts: counts };
}
