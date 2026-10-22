import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import Papa from 'papaparse';
const prisma = new PrismaClient();

const csvText = fs.readFileSync('scratch/item2-tdcc-offshore-yahoo-mapping.csv', 'utf8');
const rows = Papa.parse(csvText, { header: true, skipEmptyLines: true }).data;
const exactMatches = rows.filter(r => r.exact_match === 'true' && r.yahoo_fund_id);
// pick 10 spread across the list
const picks = [];
const step = Math.floor(exactMatches.length / 10);
for (let i = 0; i < 10; i++) picks.push(exactMatches[i * step]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

for (const p of picks) {
  const fundRow = await prisma.$queryRawUnsafe(`SELECT code, name, currency, latest_nav::text, latest_nav_date FROM funds WHERE code = $1`, p.db_code);
  const f = fundRow[0];
  try {
    const timeslot = `${new Date(Date.now() - 10*86400000).toISOString().slice(0,19)}Z-${new Date().toISOString().slice(0,19)}Z`;
    const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsPriceHistory;fundId=${encodeURIComponent(p.yahoo_fund_id)};timeslot=${encodeURIComponent(timeslot)}?intl=tw&lang=zh-Hant-TW&region=TW&site=finance&device=desktop&returnMeta=true`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403 || res.status === 429) { console.log(`RATE LIMITED ${res.status}, stopping`); break; }
    const json = await res.json();
    const closePrices = json?.closePrices ?? json?.data?.closePrices;
    const dates = json?.dates ?? json?.data?.dates;
    const lastNav = Array.isArray(closePrices) ? closePrices[closePrices.length-1] : null;
    const lastDate = Array.isArray(dates) ? dates[dates.length-1] : null;
    console.log(`${p.db_code} | DB: ${f?.currency} ${f?.latest_nav} (${f?.latest_nav_date?.toISOString?.().slice(0,10)}) | Yahoo fundsPriceHistory: nav=${lastNav} date=${lastDate}`);
  } catch (e) {
    console.log(`${p.db_code}: ERROR ${e.message}`);
  }
  await sleep(1100);
}
await prisma.$disconnect();
