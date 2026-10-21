// 使用者核准：8檔TDCC代碼/ISIN比對不到的境外基金設 isActive=false（確認不在核心母體
// tw_purchasable_classification，不影響既有自選/比較/提醒的直接查詢，只影響列表/搜尋/下拉選單）。
// 備份表+RLS+REVOKE、單一交易、執行前後筆數一致。
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const BACKUP_TABLE = "funds_inactive_8_backup_20261021";
const CODES = ["ABMOPEAAUDH", "ABMOPEAUSD", "NNJEXUSDH", "NNJEYUSDH", "NNJEPJPY", "NNJEXJPY", "NNJEXUSD", "DIT-ENC"];

async function main() {
  const pre = await prisma.$queryRawUnsafe<{ code: string; is_active: boolean }[]>(`SELECT code, is_active FROM funds WHERE code = ANY($1::text[])`, CODES);
  console.log(`執行前筆數 = ${pre.length}（預期8），全部is_active=true: ${pre.every((r) => r.is_active)}`);
  if (pre.length !== 8) throw new Error("筆數不符，停止");

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS ${BACKUP_TABLE}`);
    await tx.$executeRawUnsafe(`CREATE TABLE ${BACKUP_TABLE} AS SELECT *, now() AS backed_up_at FROM funds WHERE code = ANY($1::text[])`, CODES);
    await tx.$executeRawUnsafe(`ALTER TABLE ${BACKUP_TABLE} ENABLE ROW LEVEL SECURITY`);
    await tx.$executeRawUnsafe(`REVOKE ALL ON ${BACKUP_TABLE} FROM anon, authenticated`);
    const rls = await tx.$queryRawUnsafe<{ relrowsecurity: boolean }[]>(`SELECT relrowsecurity FROM pg_class WHERE relname = $1`, BACKUP_TABLE);
    const grants = await tx.$queryRawUnsafe<any[]>(`SELECT grantee FROM information_schema.role_table_grants WHERE table_name = $1 AND grantee IN ('anon','authenticated')`, BACKUP_TABLE);
    console.log(`[查詢證明] RLS=${rls[0]?.relrowsecurity} 殘留權限=${grants.length}`);
    if (!rls[0]?.relrowsecurity || grants.length > 0) throw new Error("RLS/REVOKE未就位");

    const updated = await tx.$executeRawUnsafe(`UPDATE funds SET is_active = false, updated_at = now() WHERE code = ANY($1::text[])`, CODES);
    console.log(`[UPDATE] 筆數 = ${updated}（預期8）`);
    if (updated !== 8) throw new Error("筆數不符，回滾");

    const post = await tx.$queryRawUnsafe<{ code: string; is_active: boolean }[]>(`SELECT code, is_active FROM funds WHERE code = ANY($1::text[])`, CODES);
    console.log(`[驗證] 全部is_active=false: ${post.every((r) => !r.is_active)}`);
    if (!post.every((r) => !r.is_active)) throw new Error("驗證失敗，回滾");
  });
  console.log("交易已成功 COMMIT。");
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("失敗:", e.message ?? e); await prisma.$disconnect(); process.exitCode = 1; });
