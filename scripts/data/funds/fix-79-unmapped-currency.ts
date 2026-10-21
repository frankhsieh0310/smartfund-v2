// 修正 apply-currency-fix-1016.ts 的上游資料錯誤：CUR_MAP 漏了「日幣」「加幣」兩個對應，
// 造成76+3=79檔被寫入中文字串而不是ISO代碼。這是修正剛才那次修正裡的bug，範圍仍在
// 使用者已核准的1016檔之內（這79檔本來就在清單裡，只是isoCode算錯），沿用同樣的安全條件。
import { PrismaClient } from "@prisma/client";
import fs from "fs";

const prisma = new PrismaClient();

async function main() {
  const list: { code: string; correctIso: string }[] = JSON.parse(fs.readFileSync(
    "C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Desktop-tw-data-updater/1cb3a135-d2a6-4f7e-b9d2-604385fefaf2/scratchpad/currency_fix_correction_79.json",
    "utf8",
  ));
  const codes = list.map((r) => r.code);
  console.log(`準備修正筆數 = ${list.length}`);

  const pre = await prisma.$queryRawUnsafe<{ code: string; currency: string }[]>(
    `SELECT code, currency FROM funds WHERE code = ANY($1::text[])`, codes,
  );
  if (pre.length !== list.length) throw new Error(`修正前筆數不符：DB=${pre.length} vs 清單=${list.length}`);
  const notWrong = pre.filter((r) => r.currency !== "日幣" && r.currency !== "加幣");
  if (notWrong.length > 0) throw new Error(`有筆資料目前的currency不是預期的錯誤值，停止：${JSON.stringify(notWrong)}`);

  await prisma.$transaction(async (tx) => {
    const params: unknown[] = [codes];
    const sql = `UPDATE funds SET currency = CASE code ${list.map((r, i) => `WHEN $${i * 2 + 2}::text THEN $${i * 2 + 3}::text`).join(" ")} END, updated_at = now() WHERE code = ANY($1::text[])`;
    for (const r of list) params.push(r.code, r.correctIso);
    const updated = await tx.$executeRawUnsafe(sql, ...params);
    console.log(`[UPDATE] 實際更新筆數 = ${updated}（預期 ${list.length}）`);
    if (updated !== list.length) throw new Error("更新筆數不符，回滾");

    const post = await tx.$queryRawUnsafe<{ code: string; currency: string }[]>(
      `SELECT code, currency FROM funds WHERE code = ANY($1::text[])`, codes,
    );
    const isoByCode = new Map(list.map((r) => [r.code, r.correctIso]));
    const wrong = post.filter((r) => isoByCode.get(r.code) !== r.currency);
    console.log(`[驗證] 修正後仍不符的筆數 = ${wrong.length}（預期 0）`);
    if (wrong.length > 0) { console.log(wrong); throw new Error("修正失敗，回滾"); }

    const stillBad = await tx.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM funds WHERE currency IN ('日幣','加幣')`,
    );
    console.log(`[驗證] 全表仍殘留中文幣別字串的筆數 = ${stillBad[0].n}（預期 0）`);
    if (Number(stillBad[0].n) !== 0) throw new Error("全表仍有殘留中文幣別，回滾");
  });

  console.log("交易已成功 COMMIT。");
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error("執行失敗：", e.message ?? e);
  await prisma.$disconnect();
  process.exitCode = 1;
});
