import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const cols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='stocks' ORDER BY ordinal_position`);
console.log(cols.map(c=>c.column_name).join(', '));
const sample = await prisma.$queryRawUnsafe(`SELECT DISTINCT market FROM stocks LIMIT 20`).catch(()=>null);
console.log('market distinct (if exists):', JSON.stringify(sample));
await prisma.$disconnect();
