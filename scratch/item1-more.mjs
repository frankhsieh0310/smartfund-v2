import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 10000`);
const etf = await prisma.$queryRawUnsafe(`SELECT code, name, latest_price::text, price_updated_at FROM etfs WHERE code='0050'`);
console.log('0050 ETF:', JSON.stringify(etf));
const instCount = await prisma.$queryRawUnsafe(`SELECT max(date) maxdate, count(*) FILTER (WHERE date='2026-10-12')::int n1012 FROM institutional_daily`);
console.log('institutional_daily coverage:', JSON.stringify(instCount));
await prisma.$disconnect();
