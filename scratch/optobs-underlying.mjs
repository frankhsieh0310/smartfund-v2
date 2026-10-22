import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const cols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='option_contracts'`);
console.log('option_contracts columns:', cols.map(c=>c.column_name).join(', '));
const total = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM option_contracts`);
console.log('option_contracts total:', JSON.stringify(total));
await prisma.$disconnect();
