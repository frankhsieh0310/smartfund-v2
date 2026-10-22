import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const rows = await prisma.$queryRawUnsafe(`
  SELECT date, min(created_at) first_write, max(created_at) last_write, count(*)::int n
  FROM institutional_daily
  WHERE date >= '2026-09-28'
  GROUP BY date ORDER BY date DESC
`);
console.log(JSON.stringify(rows, null, 1));
await prisma.$disconnect();
