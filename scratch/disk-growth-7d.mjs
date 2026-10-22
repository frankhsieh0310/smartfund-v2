import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 25000`);

for (const t of ['option_observations', 'stock_history', 'stock_technical', 'fund_history']) {
  const r = await prisma.$queryRawUnsafe(`
    SELECT to_char(created_at,'YYYY-MM-DD') d, count(*)::int n
    FROM ${t} WHERE created_at > now() - interval '7 days'
    GROUP BY d ORDER BY d
  `).catch(e => ({error: e.message}));
  console.log(t, ':', JSON.stringify(r));
}
await prisma.$disconnect();
