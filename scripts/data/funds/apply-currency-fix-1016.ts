// 2026-10-21 幣別修正（使用者已核准 1,016 檔全部執行）。
// 條件：備份表先建立+立即RLS+REVOKE anon/authenticated（附查詢證明）、單一交易內執行、
// 執行前後筆數一致、只動這1,016筆（以 currency_export_data.json 的 code 清單為準，不多不少）。
import { PrismaClient } from "@prisma/client";
import fs from "fs";

const prisma = new PrismaClient();
const BACKUP_TABLE = "funds_currency_backup_20261021";

async function main() {
  const dataPath = "C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Desktop-tw-data-updater/1cb3a135-d2a6-4f7e-b9d2-604385fefaf2/scratchpad/currency_export_data.json";
  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const rows: { code: string; isoCode: string }[] = [...data.tdccRows, ...data.sitcaRows].map((r: any) => ({ code: r.code, isoCode: r.isoCode }));
  const codes = rows.map((r) => r.code);
  if (new Set(codes).size !== codes.length) throw new Error("重複的 code，停止執行");
  console.log(`準備修正的檔數（TDCC ${data.tdccRows.length} + SITCA ${data.sitcaRows.length}）= ${rows.length}`);

  const preCount = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM funds WHERE code = ANY($1::text[])`, codes,
  );
  console.log(`修正前：這份清單在 funds 表裡目前存在的筆數 = ${preCount[0].n}（預期 ${rows.length}）`);
  if (Number(preCount[0].n) !== rows.length) {
    throw new Error(`筆數不符，停止執行（DB裡找到 ${preCount[0].n} 筆，清單有 ${rows.length} 筆）`);
  }

  await prisma.$transaction(async (tx) => {
    // 1) 備份表（含完整欄位）
    await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS ${BACKUP_TABLE}`);
    await tx.$executeRawUnsafe(
      `CREATE TABLE ${BACKUP_TABLE} AS SELECT *, now() AS backed_up_at FROM funds WHERE code = ANY($1::text[])`, codes,
    );
    const backupCount = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM ${BACKUP_TABLE}`);
    console.log(`\n[備份] ${BACKUP_TABLE} 建立完成，筆數 = ${backupCount[0].n}`);

    // 2) 立刻啟用 RLS + REVOKE anon/authenticated
    await tx.$executeRawUnsafe(`ALTER TABLE ${BACKUP_TABLE} ENABLE ROW LEVEL SECURITY`);
    await tx.$executeRawUnsafe(`REVOKE ALL ON ${BACKUP_TABLE} FROM anon, authenticated`);
    const grants = await tx.$queryRawUnsafe<{ grantee: string; privilege_type: string }[]>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = $1 AND grantee IN ('anon','authenticated')`,
      BACKUP_TABLE,
    );
    const rlsStatus = await tx.$queryRawUnsafe<{ relrowsecurity: boolean }[]>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = $1`, BACKUP_TABLE,
    );
    console.log(`[查詢證明] RLS enabled = ${rlsStatus[0]?.relrowsecurity}`);
    console.log(`[查詢證明] anon/authenticated 剩餘權限筆數 = ${grants.length}（預期0）：`, grants);
    if (grants.length > 0) throw new Error("REVOKE 後仍有殘留權限，停止交易");
    if (!rlsStatus[0]?.relrowsecurity) throw new Error("RLS 未啟用，停止交易");

    // 3) 單一交易內逐筆 UPDATE（用 CASE 對應 code -> isoCode）
    const params: unknown[] = [codes];
    const sql = `UPDATE funds SET currency = CASE code ${rows.map((r, i) => `WHEN $${i * 2 + 2}::text THEN $${i * 2 + 3}::text`).join(" ")} END, updated_at = now() WHERE code = ANY($1::text[])`;
    for (const r of rows) params.push(r.code, r.isoCode);
    const updated = await tx.$executeRawUnsafe(sql, ...params);
    console.log(`\n[UPDATE] 實際更新筆數 = ${updated}（預期 ${rows.length}）`);
    if (updated !== rows.length) throw new Error(`更新筆數不符（${updated} vs ${rows.length}），回滾交易`);

    // 4) 執行後筆數一致性 + 只動這1016筆（檢查「最近修改」筆數剛好等於清單筆數，且集合一致）
    const postCount = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM funds WHERE code = ANY($1::text[])`, codes);
    const recentlyTouched = await tx.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM funds WHERE updated_at >= now() - interval '2 minutes'`,
    );
    const recentlyTouchedNotInList = await tx.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM funds WHERE updated_at >= now() - interval '2 minutes' AND NOT (code = ANY($1::text[]))`,
      codes,
    );
    console.log(`[驗證] 修正後清單筆數仍為 = ${postCount[0].n}（應等於修正前 ${preCount[0].n}，筆數不變，只是改欄位值）`);
    console.log(`[驗證] 近2分鐘內 updated_at 被更新的 funds 總筆數 = ${recentlyTouched[0].n}（預期 = ${rows.length}）`);
    console.log(`[驗證] 近2分鐘內被更新、但不在這1016筆清單裡的筆數 = ${recentlyTouchedNotInList[0].n}（預期 0，確認沒有動到其他資料）`);
    if (Number(recentlyTouchedNotInList[0].n) !== 0) throw new Error("偵測到清單外的資料被更動，回滾交易");
    if (Number(postCount[0].n) !== rows.length) throw new Error("修正後筆數不符，回滾交易");

    // 5) 逐筆核對 currency 真的改成清單裡的 isoCode
    const mismatches = await tx.$queryRawUnsafe<{ code: string; currency: string }[]>(
      `SELECT code, currency FROM funds WHERE code = ANY($1::text[])`, codes,
    );
    const isoByCode = new Map(rows.map((r) => [r.code, r.isoCode]));
    const wrong = mismatches.filter((m) => isoByCode.get(m.code) !== m.currency);
    console.log(`[驗證] 修正後 currency 與清單不符的筆數 = ${wrong.length}（預期 0）`);
    if (wrong.length > 0) { console.log(wrong); throw new Error("有筆資料 currency 沒改成預期值，回滾交易"); }
  });

  console.log("\n交易已成功 COMMIT。");
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error("\n執行失敗，交易已回滾（或從未COMMIT）：", e.message ?? e);
  await prisma.$disconnect();
  process.exitCode = 1;
});
