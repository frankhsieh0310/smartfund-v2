import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 10000`);

const stocks = await prisma.$queryRawUnsafe(`
  SELECT s.ticker, sh.date, sh.close FROM stocks s
  JOIN stock_history sh ON sh.stock_id = s.id
  WHERE s.ticker IN ('2330','0050','2317') AND sh.date = '2026-10-12'
`);
console.log('stock_history 10/12:', JSON.stringify(stocks, (k,v)=>typeof v==='bigint'?v.toString():v));

const inst = await prisma.$queryRawUnsafe(`
  SELECT ticker, date, foreign_net, trust_net, dealer_net FROM institutional_daily WHERE ticker IN ('2330','0050','2317') AND date='2026-10-12'
`).catch(async e => {
  console.log('institutional_daily column names may differ, checking schema:', e.message);
  const cols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='institutional_daily'`);
  console.log(cols.map(c=>c.column_name).join(', '));
  return [];
});
console.log('institutional_daily 10/12:', JSON.stringify(inst));

const hk = await prisma.$queryRawUnsafe(`SELECT code, name, latest_price::text, price_updated_at FROM etfs WHERE code='2800.HK'`);
console.log('2800.HK current:', JSON.stringify(hk));
await prisma.$disconnect();
