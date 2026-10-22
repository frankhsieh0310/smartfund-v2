import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const dateRange = await prisma.$queryRawUnsafe(`SELECT min(observed_at) mn, max(observed_at) mx FROM option_observations`);
console.log('date range:', JSON.stringify(dateRange));
const srcCount = await prisma.$queryRawUnsafe(`SELECT source, count(*)::int n FROM option_observations GROUP BY source`);
console.log('by source:', JSON.stringify(srcCount));
// underlying via option_contracts join
const cols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='option_contracts'`);
console.log('option_contracts columns:', cols.map(c=>c.column_name).join(', '));
await prisma.$disconnect();
