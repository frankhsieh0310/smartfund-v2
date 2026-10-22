import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 10000`);
const sources = await prisma.$queryRawUnsafe(`
  SELECT source, count(*)::int n FROM etf_history WHERE date >= '2026-09-01' GROUP BY source ORDER BY n DESC LIMIT 20
`);
console.log('etf_history source dist (since 9/1):', JSON.stringify(sources));
await prisma.$disconnect();
