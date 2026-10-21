// 2026-10-21（幣別修正前置檢查，使用者要求）: 用真實的 matchSitcaRows/checkNavSanity（不是
// 重新實作）模擬「如果這62檔SITCA基金的currency已經修正」，確認修正後不會反而被checkNavSanity
// 擋下（JUMP_REVIEW/UNIT_MISMATCH），也確認原本被currency gate擋住的這62檔修正後會變成
// currencyOk。只讀不寫，不觸碰funds表。
import { fetchSitcaRows } from "../../../lib/sitca-nav-sync/sitcaFetch";
import { matchSitcaRows, type FundRow } from "../../../lib/sitca-nav-sync/matching";
import { checkNavSanity } from "../../../lib/sitca-nav-sync/navSanity";
import { PrismaClient } from "@prisma/client";
import fs from "fs";

const prisma = new PrismaClient();

async function main() {
  const mismatchData = JSON.parse(fs.readFileSync(
    "C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Desktop-tw-data-updater/1cb3a135-d2a6-4f7e-b9d2-604385fefaf2/scratchpad/currency_export_data.json",
    "utf8",
  ));
  const sitcaFixes = new Map<string, string>(mismatchData.sitcaRows.map((r: any) => [r.code, r.isoCode]));

  console.log("Fetching live SITCA CSV via the real fetchSitcaRows()...");
  const sitcaRows = await fetchSitcaRows();

  const fundRows = await prisma.$queryRawUnsafe<FundRow[]>(
    `SELECT id, code, name, currency FROM funds WHERE COALESCE(data_provider, '') NOT IN ('yahoo', 'SEC')`,
  );
  // Simulate the fix: swap in the corrected currency for the 62 affected funds only.
  const fixedFundRows = fundRows.map((f) => (f.code && sitcaFixes.has(f.code) ? { ...f, currency: sitcaFixes.get(f.code)! } : f));

  const beforeMatch = matchSitcaRows(sitcaRows, fundRows);
  const afterMatch = matchSitcaRows(sitcaRows, fixedFundRows);

  const beforeMismatchCount = beforeMatch.matched.filter((m) => m.sitcaCurrency !== m.fundCurrency && sitcaFixes.has(fundRows.find((f) => f.id === m.fundId)?.code ?? "")).length;
  const afterMismatchCount = afterMatch.matched.filter((m) => m.sitcaCurrency !== m.fundCurrency && sitcaFixes.has(fixedFundRows.find((f) => f.id === m.fundId)?.code ?? "")).length;
  console.log(`修正前（目前狀態）：這62檔裡，還在今天CSV出現且currency仍不一致（會被擋）的筆數 = ${beforeMismatchCount}`);
  console.log(`修正後（模擬）：這62檔裡，currency已修正、今天CSV出現但currency仍不一致（會被擋）的筆數 = ${afterMismatchCount}（預期0）`);

  // Now check checkNavSanity doesn't newly reject any of these 62 after the fix (using real last-known NAV).
  const latestNavByFundId = new Map<string, number | null>();
  const affectedFundIds = [...sitcaFixes.keys()].map((code) => fundRows.find((f) => f.code === code)?.id).filter(Boolean) as string[];
  if (affectedFundIds.length) {
    const navRows = await prisma.$queryRawUnsafe<{ id: string; latest_nav: string | null }[]>(
      `SELECT id, latest_nav::text FROM funds WHERE id = ANY($1::text[])`, affectedFundIds,
    );
    for (const r of navRows) latestNavByFundId.set(r.id, r.latest_nav != null ? Number(r.latest_nav) : null);
  }
  let willWrite = 0, jumpReview = 0, unitMismatch = 0, notInTodaysCsv = 0;
  const afterMatchByFundId = new Map(afterMatch.matched.map((m) => [m.fundId, m]));
  for (const code of sitcaFixes.keys()) {
    const fundId = fixedFundRows.find((f) => f.code === code)?.id;
    if (!fundId) continue;
    const m = afterMatchByFundId.get(fundId);
    if (!m) { notInTodaysCsv++; continue; }
    if (m.sitcaCurrency !== m.fundCurrency) continue; // shouldn't happen post-fix per above check
    const sanity = checkNavSanity(m.nav, latestNavByFundId.get(fundId) ?? null);
    if (sanity === "JUMP_REVIEW") jumpReview++;
    else if (sanity === "UNIT_MISMATCH") unitMismatch++;
    else willWrite++;
  }
  console.log(`\n模擬「修正後」這62檔今天會不會真的寫入：`);
  console.log(`  今天的CSV裡沒有這檔（本來就不會寫，不是修正造成的）: ${notInTodaysCsv}`);
  console.log(`  通過currency gate + checkNavSanity，會正常寫入: ${willWrite}`);
  console.log(`  被checkNavSanity擋下 JUMP_REVIEW（數值異常跳動）: ${jumpReview}`);
  console.log(`  被checkNavSanity擋下 UNIT_MISMATCH（單位可能錯誤）: ${unitMismatch}`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
