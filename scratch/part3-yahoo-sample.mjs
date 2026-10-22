import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 10000`);

const symbols = ['0050.TW', '2330.TW', '00919.TW', '0056.TW', '2800.HK', '1306.T'];
const rows = await prisma.$queryRawUnsafe(`
  SELECT s.ticker, s.yahoo_symbol, sh.date, sh.close
  FROM stocks s JOIN stock_history sh ON sh.stock_id = s.id
  WHERE s.yahoo_symbol = ANY($1)
  AND sh.date = (SELECT max(date) FROM stock_history WHERE stock_id = s.id)
`, symbols);
console.log('DB latest values:', JSON.stringify(rows, null, 1));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
for (const sym of symbols) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403 || res.status === 429) { console.log(`${sym}: RATE LIMITED ${res.status}, stopping`); break; }
    const json = await res.json();
    const result = json.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close;
    const timestamps = result?.timestamp;
    const lastIdx = closes?.length - 1;
    const lastClose = closes?.[lastIdx];
    const lastDate = timestamps ? new Date(timestamps[lastIdx] * 1000).toISOString().slice(0,10) : null;
    console.log(`${sym}: Yahoo latest close=${lastClose} date=${lastDate}`);
  } catch (e) { console.log(`${sym}: ERROR ${e.message}`); }
  await sleep(1100);
}
await prisma.$disconnect();
