import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const rows = await prisma.$queryRawUnsafe(`SELECT code, name, currency FROM funds WHERE code LIKE '00526748%' OR code LIKE '88394063%' ORDER BY code`);
for (const r of rows) console.log(r.code, '|', r.currency, '|', r.name);
await prisma.$disconnect();
