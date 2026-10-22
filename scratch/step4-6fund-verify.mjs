import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';
const prisma = new PrismaClient();

const res = await fetch('https://www.sitca.org.tw/MemberK0000/F/03/nav.csv', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
const text = await res.text();
const parsed = Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
const byTaxId = new Map();
for (const row of parsed.data) {
  const taxId = row['基金統編']?.trim();
  if (taxId) byTaxId.set(taxId, { name: row['基金名稱']?.trim(), nav: Number(row['基金淨值']), navDate: row['日期'], currency: row['幣別']?.trim() });
}

// specific, not ORDER BY name LIMIT: hand-picked codes confirmed earlier to be foreign-currency classes
const picks = ['00505743F', '00505743J', '25681952B', '25681952E', '21718388C', '21718388D'];
const funds = await prisma.$queryRawUnsafe(`
  SELECT id, code, name, currency, latest_nav::text, latest_nav_date
  FROM funds WHERE code = ANY($1::text[])
`, picks);

console.log('=== DB state after fix ===');
for (const f of funds) {
  const sitca = byTaxId.get(f.code);
  const navMatch = sitca && Math.abs(sitca.nav - Number(f.latest_nav)) < 0.0001;
  const ccyMatch = sitca && sitca.currency === f.currency;
  console.log(`${f.name} (${f.code})`);
  console.log(`  DB: currency=${f.currency} nav=${f.latest_nav} date=${f.latest_nav_date.toISOString().slice(0,10)}`);
  console.log(`  SITCA: currency=${sitca?.currency} nav=${sitca?.nav} date=${sitca?.navDate}`);
  console.log(`  currency match=${ccyMatch}, nav match=${navMatch}`);
}

// Mobile API check
const mobileRes = await fetch('https://smartfund-v2.vercel.app/api/mobile/current-market-data?scope=all&asset=FUND');
const mobileJson = await mobileRes.json();
const mobileFunds = mobileJson.data?.funds ?? [];
const mobileByCode = new Map(mobileFunds.map(f => [f.officialCode, f]));
console.log('\n=== Mobile API currency display ===');
for (const code of picks) {
  const m = mobileByCode.get(code);
  console.log(`${code}: mobile API currency=${m?.currency ?? 'NOT FOUND'}`);
}

await prisma.$disconnect();
