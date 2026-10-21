// 使用者核准：全表currency非ISO格式的6,716筆（data_provider='yahoo'/'MoneyDJ'）依14種中文值
// 一對一對照改成ISO代碼。備份表+RLS+REVOKE、單一交易、執行前後筆數一致、只動這6,716筆。
import { PrismaClient } from "@prisma/client";

const CUR_MAP: Record<string, string> = {
  "美元": "USD", "新台幣": "TWD", "歐元": "EUR", "澳幣": "AUD", "離岸人民幣": "CNY",
  "南非幣": "ZAR", "日圓": "JPY", "英鎊": "GBP", "新加坡幣": "SGD", "紐西蘭幣": "NZD",
  "港幣": "HKD", "加拿大幣": "CAD", "瑞典幣": "SEK", "瑞士法郎": "CHF",
};
const BACKUP_TABLE = "funds_currency_backup_yahoo_20261021";

const prisma = new PrismaClient();
async function main() {
  const rows = await prisma.$queryRawUnsafe<{ id: string; currency: string }[]>(
    `SELECT id, currency FROM funds WHERE currency IS NOT NULL AND currency !~ '^[A-Z]{3}$'`,
  );
  console.log(`準備修正筆數 = ${rows.length}`);
  const unmapped = rows.filter((r) => !CUR_MAP[r.currency]);
  if (unmapped.length > 0) throw new Error(`有無法對應的值，停止：${JSON.stringify(unmapped.slice(0, 5))}`);
  const ids = rows.map((r) => r.id);

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS ${BACKUP_TABLE}`);
    await tx.$executeRawUnsafe(`CREATE TABLE ${BACKUP_TABLE} AS SELECT *, now() AS backed_up_at FROM funds WHERE id = ANY($1::text[])`, ids);
    const backupCount = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM ${BACKUP_TABLE}`);
    console.log(`[備份] ${BACKUP_TABLE} 建立完成，筆數 = ${backupCount[0].n}`);
    await tx.$executeRawUnsafe(`ALTER TABLE ${BACKUP_TABLE} ENABLE ROW LEVEL SECURITY`);
    await tx.$executeRawUnsafe(`REVOKE ALL ON ${BACKUP_TABLE} FROM anon, authenticated`);
    const grants = await tx.$queryRawUnsafe<{ grantee: string; privilege_type: string }[]>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = $1 AND grantee IN ('anon','authenticated')`, BACKUP_TABLE,
    );
    const rls = await tx.$queryRawUnsafe<{ relrowsecurity: boolean }[]>(`SELECT relrowsecurity FROM pg_class WHERE relname = $1`, BACKUP_TABLE);
    console.log(`[查詢證明] RLS=${rls[0]?.relrowsecurity} anon/authenticated殘留權限=${grants.length}`);
    if (grants.length > 0 || !rls[0]?.relrowsecurity) throw new Error("RLS/REVOKE未就位，停止");

    const params: unknown[] = [ids];
    const sql = `UPDATE funds SET currency = CASE id ${rows.map((r, i) => `WHEN $${i * 2 + 2}::text THEN $${i * 2 + 3}::text`).join(" ")} END, updated_at = now() WHERE id = ANY($1::text[])`;
    for (const r of rows) params.push(r.id, CUR_MAP[r.currency]);
    const updated = await tx.$executeRawUnsafe(sql, ...params);
    console.log(`[UPDATE] 實際更新筆數 = ${updated}（預期 ${rows.length}）`);
    if (updated !== rows.length) throw new Error("更新筆數不符，回滾");

    const stillBad = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM funds WHERE currency IS NOT NULL AND currency !~ '^[A-Z]{3}$'`);
    console.log(`[驗證] 全表仍殘留非ISO字串的筆數 = ${stillBad[0].n}（預期 0）`);
    if (Number(stillBad[0].n) !== 0) throw new Error("全表仍有殘留，回滾");
  });
  console.log("交易已成功 COMMIT。");
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("失敗:", e.message ?? e); await prisma.$disconnect(); process.exitCode = 1; });
