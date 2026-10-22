import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';
const prisma = new PrismaClient();
function nfkcNameKey(name) { return String(name ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/臺/g, '台').toLowerCase(); }
function primaryClassMarker(name) {
  const n = String(name ?? '').split('(')[0];
  if (/累積/.test(n)) return '累積';
  if (/配息/.test(n)) return '配息';
  for (const cls of ['A類','B類','N類','I類','A股','B股']) if (n.includes(cls)) return cls;
  return null;
}
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
const funds = await prisma.$queryRawUnsafe(`SELECT id, code, name, currency, latest_nav, latest_nav_date FROM funds WHERE currency IS NOT NULL`);
const byCode = new Map(); for (const f of funds) if (f.code) byCode.set(f.code, f);
const byName = new Map(); for (const f of funds) { const k = nfkcNameKey(f.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(f); }
const matched = [];
for (const row of rows) {
  const hit = byCode.get(row.taxId);
  if (hit) { matched.push({ row, fund: hit, matchedBy: 'CODE' }); continue; }
  const nh = byName.get(nfkcNameKey(row.name));
  if (nh && nh.length === 1) matched.push({ row, fund: nh[0], matchedBy: 'NAME' });
}
const safe = matched.filter(m => {
  const sitcaIsTwd = m.row.currency === 'TWD';
  const dbIsTwd = m.fund.currency === 'TWD' || m.fund.currency === '新台幣';
  return sitcaIsTwd === dbIsTwd;
});
let willAdvanceDate = 0, sameDateDiffValue = 0, alreadyCurrent = 0, dbNeverSet = 0;
for (const m of safe) {
  if (!m.fund.latest_nav_date) { dbNeverSet++; continue; }
  const dbDate = m.fund.latest_nav_date.toISOString().slice(0, 10);
  if (dbDate < m.row.navDate) willAdvanceDate++;
  else if (dbDate === m.row.navDate && Number(m.fund.latest_nav) !== m.row.nav) sameDateDiffValue++;
  else alreadyCurrent++;
}
console.log(`safe-to-write total: ${safe.length}`);
console.log(`  would advance latest_nav_date (older DB date -> SITCA's newer date): ${willAdvanceDate}`);
console.log(`  same date but different value (would update per shared rule): ${sameDateDiffValue}`);
console.log(`  already current (no-op write): ${alreadyCurrent}`);
console.log(`  DB latest_nav_date never set (NULL): ${dbNeverSet}`);
console.log(`\nLatest SITCA navDate seen in file: ${[...new Set(rows.map(r=>r.navDate))].sort().slice(-3).join(', ')}`);
await prisma.$disconnect();
