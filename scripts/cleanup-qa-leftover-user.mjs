// 一次性腳本：清除上一輪 QA 測試帳號殘留的 User 列與關聯資料。
// 只處理這一個寫死的 userId（舊的 QA 測試帳號，Supabase 登入身分已經刪除，只剩 DB 資料殘留）。
// 使用跟 app/api/me/route.ts 的 DELETE 完全相同的刪除順序（已修好的版本）：
// 先刪兩個會擋刪除的 RESTRICT 關聯（alert_rule_versions.created_by、
// watchlist_membership_events.actor_user_id），再刪兩個會留孤兒資料的 SET NULL 關聯
// （compare_sessions.user_id、search_logs.user_id），最後刪 User 本身（其餘關聯都是
// CASCADE，刪 User 會自動清乾淨）。全部包在一個交易裡，任何一步失敗就整個回復。
//
// 執行方式（在你自己的電腦、在 smartfund-v2 這個 repo 目錄下）：
//   node scripts/cleanup-qa-leftover-user.mjs
// 需要 .env 裡有 DATABASE_URL（正式環境的，跟你平常部署用的那份一樣）。

import { PrismaClient } from "@prisma/client";

const USER_ID = "8d48e1a9-0819-498c-91fe-8722fa46f2f3"; // QA 測試帳號的 DB User.id

const prisma = new PrismaClient();

async function main() {
  const before = await prisma.$queryRawUnsafe(`SELECT id, email FROM users WHERE id = $1`, USER_ID);
  console.log("刪除前查到的帳號：", JSON.stringify(before));

  if (before.length === 0) {
    console.log("這個 User 已經不存在，不需要再刪一次。");
    return;
  }

  await prisma.$transaction([
    prisma.$executeRaw`DELETE FROM watchlist_membership_events WHERE actor_user_id = ${USER_ID}`,
    prisma.$executeRaw`DELETE FROM alert_rule_versions WHERE created_by = ${USER_ID}`,
    prisma.$executeRaw`DELETE FROM compare_sessions WHERE user_id = ${USER_ID}`,
    prisma.$executeRaw`DELETE FROM search_logs WHERE user_id = ${USER_ID}`,
    prisma.user.delete({ where: { id: USER_ID } }),
  ]);

  const after = await prisma.$queryRawUnsafe(`SELECT id FROM users WHERE id = $1`, USER_ID);
  console.log("刪除後查到的帳號數量：", after.length, "（應該是 0）");
}

main()
  .catch((error) => {
    console.error("刪除失敗，交易已自動回復，沒有任何資料被改變：", error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
