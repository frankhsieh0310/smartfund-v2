import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const hk = await prisma.$queryRawUnsafe(`SELECT code, latest_price::text, price_updated_at FROM etfs WHERE code='2800.HK'`);
console.log('2800.HK:', JSON.stringify(hk));
await prisma.$disconnect();
