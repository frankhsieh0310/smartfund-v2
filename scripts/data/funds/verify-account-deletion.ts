// 2026-10-21（14點任務第4項）: 驗證「刪除帳號」真的把 Supabase auth 身分跟 users 表（含15個
// cascade關聯表）都清乾淨。READ-ONLY，不執行刪除——刪除本身要透過App裡的「刪除帳號」按鈕走
// 真實的 DELETE /api/me，這支腳本只負責刪除前後各查一次、印出對照證明。
//
// Usage:
//   npx tsx scripts/data/funds/verify-account-deletion.ts --supabase-id <uuid> --before
//   npx tsx scripts/data/funds/verify-account-deletion.ts --supabase-id <uuid> --after
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";

const prisma = new PrismaClient();

const CASCADE_TABLES = [
  "investor_questionnaires", "user_criteria", "alerts", "audit_logs", "favorites",
  "notifications", "portfolios", "saved_filters", "strategies", "strategy_favorites",
  "workspaces", "watchlists", "watchlist_membership_events",
] as const;
// 已知非cascade的關聯（DELETE /api/me的註解已經揭露這個已知缺口）：刪除User後user_id不會
// 自動清空，這裡一併查出來讓使用者知道實際狀況，不是假裝沒有這個問題。
const NON_CASCADE_TABLES = ["search_logs", "compare_sessions"] as const;

async function main() {
  const supabaseId = process.argv.find((a) => a.startsWith("--supabase-id"))
    ? process.argv[process.argv.indexOf("--supabase-id") + 1]
    : null;
  if (!supabaseId) throw new Error("usage: --supabase-id <uuid> --before|--after");

  const user = await prisma.user.findUnique({ where: { supabaseId } });
  console.log(`users 表: ${user ? `仍存在 (id=${user.id}, email=${user.email}, plan=${user.plan})` : "不存在（已刪除）"}`);

  if (user) {
    for (const table of CASCADE_TABLES) {
      const rows: { c: number }[] = await prisma.$queryRawUnsafe(`SELECT count(*)::int c FROM ${table} WHERE user_id = $1`, user.id).catch(() => [{ c: -1 }]);
      console.log(`  ${table}: ${rows[0].c} 筆`);
    }
    for (const table of NON_CASCADE_TABLES) {
      const rows: { c: number }[] = await prisma.$queryRawUnsafe(`SELECT count(*)::int c FROM ${table} WHERE user_id = $1`, user.id).catch(() => [{ c: -1 }]);
      console.log(`  [非cascade] ${table}: ${rows[0].c} 筆`);
    }
  }

  // Supabase auth.users 跟 public.users 是同一個資料庫的不同schema，DIRECT_URL可以直接查auth schema。
  const connectionString = process.env.DIRECT_URL;
  if (connectionString) {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      const authRow = await client.query(`SELECT id, email, created_at, deleted_at FROM auth.users WHERE id = $1`, [supabaseId]);
      console.log(`auth.users: ${authRow.rows.length ? `仍存在 (${JSON.stringify(authRow.rows[0])})` : "不存在（已刪除）"}`);
    } finally {
      await client.end();
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
