import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
for (const t of ['stock_history','stock_technical','fund_history']) {
  const idx = await prisma.$queryRawUnsafe(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename=$1`, t);
  console.log(t, ':', idx.map(i=>i.indexname).join(', '));
}
await prisma.$disconnect();
