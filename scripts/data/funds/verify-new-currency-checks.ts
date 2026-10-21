import { checkCoreUniverseFundCurrencyFormat, evaluateFundCurrencyOfficialConsistency } from "../../../lib/daily-health-report/checks";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const query = (sql: string, params: any[]) => prisma.$queryRawUnsafe(sql, ...params);

async function main() {
  console.log("開始執行...");
  const fmt = await checkCoreUniverseFundCurrencyFormat(query);
  console.log("checkCoreUniverseFundCurrencyFormat 執行結果:");
  console.log(JSON.stringify(fmt, null, 2));

  const officialResult = evaluateFundCurrencyOfficialConsistency([
    { code: "TEST1", dbCurrency: "USD", officialIsoCurrency: "USD", source: "TDCC" },
    { code: "TEST2", dbCurrency: "USD", officialIsoCurrency: "EUR", source: "SITCA" },
  ]);
  console.log("\nevaluateFundCurrencyOfficialConsistency 執行結果（用測試樣本驗證邏輯）:");
  console.log(JSON.stringify(officialResult, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error("ERROR:", e); process.exitCode = 1; });
