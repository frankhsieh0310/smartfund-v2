import { checkCoreUniverseFundGapDetail } from "../../../lib/daily-health-report/checks";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const query = (sql: string, params?: unknown[]) => prisma.$queryRawUnsafe<any[]>(sql, ...(params ?? []));
async function main() {
  const gap = await checkCoreUniverseFundGapDetail(query, 4);
  console.log("total gap rows:", gap.length);
  console.log(JSON.stringify(gap, null, 1));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
