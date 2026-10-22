import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const cols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='funds' ORDER BY ordinal_position`);
console.log('funds cols:', cols.map(c=>c.column_name).join(', '));
// offshore approval status - check for any approval-related table/column
const tables = await prisma.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%offshore%' OR table_name ILIKE '%tdcc%' OR table_name ILIKE '%approv%'`);
console.log('related tables:', JSON.stringify(tables));
await prisma.$disconnect();
