import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const tables = await prisma.$queryRawUnsafe(`
  SELECT table_name FROM information_schema.tables WHERE table_schema='public'
  AND (table_name ILIKE '%dividend%' OR table_name ILIKE '%distribution%')
`);
console.log('Tables:', JSON.stringify(tables));

const cols = await prisma.$queryRawUnsafe(`
  SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'
  AND (column_name ILIKE '%dividend%' OR column_name ILIKE '%distribution%' OR column_name ILIKE '%ex_date%' OR column_name ILIKE '%record_date%' OR column_name ILIKE '%payment_date%')
  ORDER BY table_name, column_name
`);
console.log('Columns:', JSON.stringify(cols, null, 1));
await prisma.$disconnect();
