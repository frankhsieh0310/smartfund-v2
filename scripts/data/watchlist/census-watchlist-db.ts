import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const [counts] = await prisma.$queryRawUnsafe<Array<Record<string, number>>>(`
    SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM assets) AS assets,
      (SELECT count(*)::int FROM stocks) AS stocks,
      (SELECT count(*)::int FROM stock_history) AS stock_history,
      (SELECT count(*)::int FROM etfs) AS etfs,
      (SELECT count(*)::int FROM etf_history) AS etf_history,
      (SELECT count(*)::int FROM funds) AS funds,
      (SELECT count(*)::int FROM alerts) AS legacy_alerts
  `);
  console.log(JSON.stringify(counts));
} finally {
  await prisma.$disconnect();
}
