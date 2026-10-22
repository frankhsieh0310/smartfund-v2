import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const sources = await prisma.$queryRawUnsafe(`SELECT source, count(*)::int n FROM etf_history GROUP BY source ORDER BY n DESC LIMIT 20`);
console.log('etf_history source distribution:', JSON.stringify(sources));
await prisma.$disconnect();
