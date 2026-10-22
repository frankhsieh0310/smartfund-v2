import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 10000`);
// etf_performances is small (95K rows) - check for odd created_at clusters outside normal cron minutes
const dist = await prisma.$queryRawUnsafe(`
  SELECT to_char(created_at,'YYYY-MM-DD') d, count(*)::int n FROM etf_performances
  WHERE created_at > '2026-09-01' GROUP BY d ORDER BY d
`);
console.log('etf_performances created_at by day:', JSON.stringify(dist));
const etfDist = await prisma.$queryRawUnsafe(`
  SELECT to_char(updated_at,'YYYY-MM-DD') d, count(*)::int n FROM etfs
  WHERE updated_at > '2026-09-01' GROUP BY d ORDER BY d
`);
console.log('etfs updated_at by day:', JSON.stringify(etfDist));
await prisma.$disconnect();
