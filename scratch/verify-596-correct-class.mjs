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

const suspect = await prisma.$queryRawUnsafe(`
  SELECT id, code, name, currency, latest_nav::text, latest_nav_date, nav_updated_at
  FROM funds
  WHERE last_nav_source = 'SITCA_FSC_OFFICIAL_DAILY_NAV_CSV' AND nav_updated_at < '2026-10-12 00:00:00'
    AND name ~ '美元|美金|日圓|日幣|人民幣|澳幣|歐元|港幣|南非幣|英鎊|加幣|紐幣|瑞士法郎|新加坡幣'
    AND currency = 'TWD'
  ORDER BY random() LIMIT 15
`);

console.log(`Sampling ${suspect.length} of the 596 suspect rows\n`);
for (const f of suspect) {
  const today = byTaxId.get(f.code);
  const nameMatch = today && today.name === f.name;
  console.log(`${f.name} (code=${f.code})`);
  console.log(`  DB stored:  nav=${f.latest_nav} date=${f.latest_nav_date.toISOString().slice(0,10)} written=${f.nav_updated_at.toISOString()}`);
  if (today) {
    console.log(`  Today SITCA (same code=${nameMatch?'name MATCHES':'name DIFFERS -- check!'}): nav=${today.nav} date=${today.navDate} currency=${today.currency}`);
    const pctDrift = ((Number(f.latest_nav) - today.nav) / today.nav * 100).toFixed(1);
    console.log(`  drift vs today: ${pctDrift}%`);
  } else {
    console.log(`  Today SITCA: code not found in today's CSV (fund may have closed/changed code)`);
  }
  console.log('');
}
await prisma.$disconnect();
