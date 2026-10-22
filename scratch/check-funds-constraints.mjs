import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const idx = await prisma.$queryRawUnsafe(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename='funds' AND indexdef ILIKE '%UNIQUE%'`);
console.log(JSON.stringify(idx, null, 1));
await prisma.$disconnect();
