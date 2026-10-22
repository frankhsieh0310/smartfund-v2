import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const rows = await prisma.$queryRawUnsafe(`
  SELECT ticker, market, foreign_net::text, trust_net::text, dealer_net::text, total_net::text
  FROM institutional_daily WHERE date='2026-10-12' AND ticker IN ('2330','2317','0050')
`);
console.log(JSON.stringify(rows, null, 1));
await prisma.$disconnect();
