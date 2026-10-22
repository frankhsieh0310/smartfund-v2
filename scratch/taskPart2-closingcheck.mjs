import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
// Taiwan holiday check for 10/9 (國慶補假) - just confirm via stock_history gap pattern
const twGap = await prisma.$queryRawUnsafe(`
  SELECT date, count(*) n FROM stock_history WHERE date BETWEEN '2026-10-06' AND '2026-10-12' GROUP BY date ORDER BY date
`);
console.log('stock_history by date (TW):', JSON.stringify(twGap));
const instGap = await prisma.$queryRawUnsafe(`
  SELECT date, count(*) n FROM institutional_daily WHERE date BETWEEN '2026-10-06' AND '2026-10-12' GROUP BY date ORDER BY date
`);
console.log('institutional_daily by date:', JSON.stringify(instGap));
await prisma.$disconnect();
