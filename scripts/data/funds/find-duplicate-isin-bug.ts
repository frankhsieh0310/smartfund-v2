// 只讀：重現 createMissingOffshoreFunds 的「missing」判定邏輯（用名稱比對existingFundNames），
// 找出第一筆「名稱判定為缺漏、但isin其實已經存在」的基金，解釋為什麼名稱比對沒抓到它。
import { fetchTdccNavCsv, parseTdccNavCsv } from "../../../lib/offshore-nav-sync/tdccBatchSource";
import { fetchTdccOffshoreBasicInfoNames } from "../../../lib/tw-purchasable/tdccOffshoreBasicInfo";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
function normalizeFundName(s: string): string { return s.replace(/[　\s]+/g, ""); }

async function main() {
  const csvText = await fetchTdccNavCsv();
  const byName = parseTdccNavCsv(csvText);
  const approvedNames = await fetchTdccOffshoreBasicInfoNames();
  const approvedNormalized = new Set([...approvedNames].map(normalizeFundName));

  const existingFunds = await prisma.$queryRawUnsafe<{ name: string; isin: string | null; code: string | null; data_provider: string | null; is_active: boolean }[]>(
    `SELECT name, isin, code, data_provider, is_active FROM funds`,
  );
  const existingFundNames = new Set(existingFunds.map((f) => f.name));
  const existingNormalized = new Set([...existingFundNames].map(normalizeFundName));
  const byIsin = new Map(existingFunds.filter((f) => f.isin).map((f) => [f.isin as string, f]));

  const conflicts: any[] = [];
  for (const [name, row] of byName) {
    if (existingFundNames.has(name) || existingNormalized.has(normalizeFundName(name))) continue;
    const isCurrentlyApproved = approvedNames.has(name) || approvedNormalized.has(normalizeFundName(name));
    if (!isCurrentlyApproved) continue;
    if (row.isin && byIsin.has(row.isin)) {
      conflicts.push({ missingName: name, missingIsin: row.isin, existingRow: byIsin.get(row.isin) });
    }
  }
  console.log(`名稱判定為「缺漏且已核備」的基金裡，isin其實已存在的衝突筆數 = ${conflicts.length}`);
  console.log(JSON.stringify(conflicts, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
