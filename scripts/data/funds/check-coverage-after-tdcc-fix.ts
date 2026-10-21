import { checkCoreUniverseFundCoverage, checkCoreUniverseEtfCoverage } from "../../../lib/daily-health-report/checks";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const query = (sql: string, params?: unknown[]) => prisma.$queryRawUnsafe<any[]>(sql, ...(params ?? []));
async function main() {
  const fund = await checkCoreUniverseFundCoverage(query, 4);
  console.log("FUND coverage:", JSON.stringify(fund, null, 1));
  const etf = await checkCoreUniverseEtfCoverage(query, 4);
  console.log("ETF coverage:", JSON.stringify(etf, null, 1));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
