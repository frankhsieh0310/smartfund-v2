import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 10000`);
const hk = await prisma.$queryRawUnsafe(`SELECT code, name, latest_price::text, price_updated_at FROM etfs WHERE code='2800.HK'`);
console.log('2800.HK now:', JSON.stringify(hk));
const instCount = await prisma.$queryRawUnsafe(`SELECT max(date) maxdate, count(*) FILTER (WHERE date='2026-10-12')::int n1012 FROM institutional_daily`);
console.log('institutional_daily now:', JSON.stringify(instCount));
await prisma.$disconnect();
