import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 10000`);
const rows = await prisma.$queryRawUnsafe(`
  SELECT code, name, latest_price::text, price_updated_at
  FROM etfs WHERE code IN ('0050','00919','0056') OR code ILIKE '2800%' OR code ILIKE '1306%'
`);
console.log('etfs table matches:', JSON.stringify(rows, null, 1));
// also try yahoo_symbol style stocks table lookups for HK/JP that might be in stocks not etfs
const stockRows = await prisma.$queryRawUnsafe(`
  SELECT s.ticker, s.yahoo_symbol, sh.date, sh.close FROM stocks s
  LEFT JOIN LATERAL (SELECT date,close FROM stock_history WHERE stock_id=s.id ORDER BY date DESC LIMIT 1) sh ON true
  WHERE s.yahoo_symbol IN ('0050.TW','00919.TW','0056.TW','2800.HK','1306.T')
`);
console.log('stocks table matches:', JSON.stringify(stockRows, null, 1));
await prisma.$disconnect();
