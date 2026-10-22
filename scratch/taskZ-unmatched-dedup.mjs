import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';
import fs from 'node:fs';
const prisma = new PrismaClient();
function nfkcNameKey(name) { return String(name ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/臺/g, '台').toLowerCase(); }

const res = await fetch('https://www.sitca.org.tw/MemberK0000/F/03/nav.csv', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
const text = await res.text();
const parsed = Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
const rows = [];
for (const row of parsed.data) {
  const taxId = row['基金統編']?.trim(), name = row['基金名稱']?.trim(), navRaw = row['基金淨值']?.trim(), rawDate = row['日期']?.trim(), currency = row['幣別']?.trim();
  if (!taxId || !name || !navRaw || !rawDate || !/^\d{8}$/.test(rawDate)) continue;
  const nav = Number(navRaw);
  if (!Number.isFinite(nav) || nav <= 0) continue;
  rows.push({ taxId, name, nav, currency, navDate: `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}` });
}
const funds = await prisma.$queryRawUnsafe(`SELECT id, code, name, currency FROM funds WHERE currency IS NOT NULL`);
const byCode = new Map(); for (const f of funds) if (f.code) byCode.set(f.code, f);
const byName = new Map(); for (const f of funds) { const k = nfkcNameKey(f.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(f); }

const unmatched = [];
for (const row of rows) {
  if (byCode.get(row.taxId)) continue;
  const nh = byName.get(nfkcNameKey(row.name));
  if (nh && nh.length === 1) continue;
  unmatched.push({ ...row, ambiguousNameMatch: nh ? nh.length : 0 });
}

console.log(`SITCA unmatched (no code match, no unique name match): ${unmatched.length} rows`);
const csvHeader = 'taxId,name,currency,nav,navDate,ambiguous_name_match_count';
const csvLines = unmatched.map(r => [r.taxId, r.name, r.currency, r.nav, r.navDate, r.ambiguousNameMatch].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
fs.writeFileSync('scratch/taskZ-sitca-unmatched-dedup.csv', [csvHeader, ...csvLines].join('\n'));
console.log('Saved to scratch/taskZ-sitca-unmatched-dedup.csv');
await prisma.$disconnect();
