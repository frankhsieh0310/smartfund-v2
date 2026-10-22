import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 8000`);
const sampleStocks = await prisma.$queryRawUnsafe(`SELECT id FROM stocks LIMIT 50`);
const ids = sampleStocks.map(s => s.id);
const twGap = await prisma.$queryRawUnsafe(`
  SELECT to_char(date,'YYYY-MM-DD') d, count(*)::int n FROM stock_history WHERE stock_id = ANY($1) AND date BETWEEN '2026-10-06' AND '2026-10-12' GROUP BY date ORDER BY date
`, ids);
console.log('stock_history sample(50 stocks) by date:', JSON.stringify(twGap));
await prisma.$disconnect();
