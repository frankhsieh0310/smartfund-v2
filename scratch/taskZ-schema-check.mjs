import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const cols = await prisma.$queryRawUnsafe(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='funds' ORDER BY ordinal_position`);
console.log(cols.map(c=>c.column_name).join(', '));
await prisma.$disconnect();
