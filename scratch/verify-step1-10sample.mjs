import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';
const prisma = new PrismaClient();

const res = await fetch('https://www.sitca.org.tw/MemberK0000/F/03/nav.csv', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
const text = await res.text();
const parsed = Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
const byTaxId = new Map();
for (const row of parsed.data) {
  const taxId = row['基金統編']?.trim();
  if (taxId) byTaxId.set(taxId, { name: row['基金名稱']?.trim(), nav: Number(row['基金淨值']), navDate: row['日期'] });
}

const picks = await prisma.$queryRawUnsafe(`
  SELECT id, code, name, latest_nav::text, latest_nav_date, last_nav_source
  FROM funds
  WHERE last_nav_source = 'SITCA_FSC_OFFICIAL_DAILY_NAV_CSV'
    AND nav_updated_at > '2026-10-12 01:00:00'
    AND (name LIKE '野村%' OR name LIKE '國泰%' OR name LIKE '元大%')
  ORDER BY name
  LIMIT 10
`);
console.log(`Found ${picks.length} 野村/國泰/元大 funds written by this run`);
for (const p of picks) {
  const sitca = byTaxId.get(p.code);
  const match = sitca && Math.abs(sitca.nav - Number(p.latest_nav)) < 0.0001;
  console.log(`${p.name} (${p.code}): DB=${p.latest_nav}/${p.latest_nav_date.toISOString().slice(0,10)} | SITCA=${sitca?.nav}/${sitca?.navDate} | match=${match}`);
}
await prisma.$disconnect();
