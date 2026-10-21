// 只讀：模擬修正後 createMissingOffshoreFunds 真的會建立的清單（排除ISIN衝突、排除幣別無法對應），
// 給使用者審查用，不寫入。
import { fetchTdccNavCsv, parseTdccNavCsv } from "../../../lib/offshore-nav-sync/tdccBatchSource";
import { fetchTdccOffshoreBasicInfoNames, fetchTdccOffshoreBasicInfoAgents } from "../../../lib/tw-purchasable/tdccOffshoreBasicInfo";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
function normalizeFundName(s: string): string { return s.replace(/[　\s]+/g, ""); }

async function main() {
  const csvText = await fetchTdccNavCsv();
  const byName = parseTdccNavCsv(csvText);
  const approvedNames = await fetchTdccOffshoreBasicInfoNames();
  const agentsByName = await fetchTdccOffshoreBasicInfoAgents();
  const agentsByNormalizedName = new Map([...agentsByName].map(([n, a]) => [normalizeFundName(n), a]));
  const approvedNormalized = new Set([...approvedNames].map(normalizeFundName));

  const existingFundRows = await prisma.$queryRawUnsafe<{ name: string; isin: string | null; code: string | null }[]>(`SELECT name, isin, code FROM funds`);
  const existingFundNames = new Set(existingFundRows.map((f) => f.name));
  const existingNormalized = new Set([...existingFundNames].map(normalizeFundName));
  const existingByIsin = new Map(existingFundRows.filter((f) => f.isin).map((f) => [f.isin as string, f]));

  const wouldCreate: any[] = [];
  const skippedIsinConflict: any[] = [];
  const skippedInvalidCurrency: any[] = [];
  for (const [name, row] of byName) {
    if (existingFundNames.has(name) || existingNormalized.has(normalizeFundName(name))) continue;
    const isCurrentlyApproved = approvedNames.has(name) || approvedNormalized.has(normalizeFundName(name));
    if (!isCurrentlyApproved) continue;
    const company = agentsByName.get(name) ?? agentsByNormalizedName.get(normalizeFundName(name)) ?? "";
    if (row.isin && existingByIsin.has(row.isin)) {
      skippedIsinConflict.push({ taxId: row.code, name, isin: row.isin, existingName: existingByIsin.get(row.isin)!.name, existingCode: existingByIsin.get(row.isin)!.code });
      continue;
    }
    const rawCurrency = row.currency;
    if (!rawCurrency || !/^[A-Z]{3}$/.test(rawCurrency)) {
      skippedInvalidCurrency.push({ taxId: row.code, name, rawCurrency });
      continue;
    }
    wouldCreate.push({ taxId: row.code, name, company, currency: rawCurrency, isin: row.isin, navDate: row.navDate, source: "TDCC_OPENDATA_NAV (dataset 3-4)" });
  }
  console.log(`修正後會建立的基金數 = ${wouldCreate.length}`);
  console.log(JSON.stringify(wouldCreate, null, 2));
  console.log(`\n因ISIN衝突不建立 = ${skippedIsinConflict.length}`);
  console.log(JSON.stringify(skippedIsinConflict, null, 2));
  console.log(`\n因幣別無法對應不建立 = ${skippedInvalidCurrency.length}`);
  console.log(JSON.stringify(skippedInvalidCurrency, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
