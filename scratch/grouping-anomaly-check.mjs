import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
// find masters with suspiciously high member counts (possible over-merging of distinct funds)
const bigMasters = await prisma.$queryRawUnsafe(`
  SELECT master_fund_id, count(*)::int n FROM fund_share_classes WHERE master_fund_id IS NOT NULL
  GROUP BY master_fund_id HAVING count(*) > 20 ORDER BY n DESC LIMIT 10
`);
console.log('Masters with >20 classes (possible over-merge):', JSON.stringify(bigMasters));
await prisma.$disconnect();
