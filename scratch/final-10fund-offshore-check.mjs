import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
const prisma = new PrismaClient();

const mapping = JSON.parse(fs.readFileSync('scratch/item3-mapping-seed.json', 'utf8'));
const step = Math.floor(mapping.length / 10);
const picks = [];
for (let i = 0; i < 10; i++) picks.push(mapping[i * step]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

for (const p of picks) {
  const fundRow = await prisma.$queryRawUnsafe(`SELECT code, currency, latest_nav::text, latest_nav_date FROM funds WHERE id = $1`, p.fundId);
  const f = fundRow[0];
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 10 * 86400000);
    const timeslot = `${from.toISOString().slice(0,19)}Z-${now.toISOString().slice(0,19)}Z`;
    const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsPriceHistory;fundId=${encodeURIComponent(p.yahooFundId)};timeslot=${encodeURIComponent(timeslot)}?intl=tw&lang=zh-Hant-TW&region=TW&site=finance&device=desktop&returnMeta=true`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403 || res.status === 429) { console.log('RATE LIMITED', res.status); break; }
    const json = await res.json();
    const closePrices = json?.closePrices ?? json?.data?.closePrices;
    const dates = json?.dates ?? json?.data?.dates;
    const nav = closePrices ? Number(closePrices[closePrices.length-1]) : null;
    const date = dates ? dates[dates.length-1] : null;
    console.log(`${p.code} | DB(stale): ${f.currency} ${f.latest_nav} (${f.latest_nav_date?.toISOString?.().slice(0,10)}) | Yahoo live: nav=${nav} date=${date}`);
  } catch (e) {
    console.log(`${p.code}: ERROR ${e.message}`);
  }
  await sleep(1100);
}
await prisma.$disconnect();
