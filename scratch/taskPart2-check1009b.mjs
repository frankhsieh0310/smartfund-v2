import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 8000`);
const exch = await prisma.$queryRawUnsafe(`SELECT DISTINCT exchange, country FROM stocks LIMIT 20`);
console.log('exchange/country distinct:', JSON.stringify(exch));
const twIds = await prisma.$queryRawUnsafe(`SELECT id FROM stocks WHERE country = 'TW' OR exchange IN ('TWSE','TPEx') LIMIT 50`);
console.log('TW sample count:', twIds.length);
if (twIds.length) {
  const ids = twIds.map(r=>r.id);
  const rows = await prisma.$queryRawUnsafe(`
    SELECT to_char(date,'YYYY-MM-DD') d, count(*)::int n FROM stock_history WHERE stock_id = ANY($1) AND date BETWEEN '2026-10-06' AND '2026-10-12' GROUP BY date ORDER BY date
  `, ids);
  console.log('TW-only stock_history by date:', JSON.stringify(rows));
}
await prisma.$disconnect();
