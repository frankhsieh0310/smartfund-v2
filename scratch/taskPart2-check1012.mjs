import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 8000`);
const twIds = await prisma.$queryRawUnsafe(`SELECT id FROM stocks WHERE country = 'TW' OR exchange IN ('TWSE','TPEx') LIMIT 50`);
const ids = twIds.map(r=>r.id);
const rows = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int n FROM stock_history WHERE stock_id = ANY($1) AND date = '2026-10-12'
`, ids);
console.log('TW 10/12 count:', JSON.stringify(rows));
const inst = await prisma.$queryRawUnsafe(`
  SELECT to_char(date,'YYYY-MM-DD') d, count(*)::int n FROM institutional_daily WHERE date BETWEEN '2026-10-06' AND '2026-10-12' GROUP BY date ORDER BY date
`);
console.log('institutional_daily:', JSON.stringify(inst));
await prisma.$disconnect();
