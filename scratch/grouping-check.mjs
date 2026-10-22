import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 10000`);
const total = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM fund_share_classes`);
console.log('fund_share_classes total:', JSON.stringify(total));
const masters = await prisma.$queryRawUnsafe(`SELECT count(DISTINCT master_fund_id)::int n FROM fund_share_classes WHERE master_fund_id IS NOT NULL`);
console.log('distinct masters:', JSON.stringify(masters));
await prisma.$disconnect();
