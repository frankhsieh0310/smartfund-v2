import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
for (const t of ['etf_distribution_events','fund_distribution_observations']) {
  const cols = await prisma.$queryRawUnsafe(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, t);
  console.log(t, ':', cols.map(c=>c.column_name).join(', '));
}
await prisma.$disconnect();
