import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';

const prisma = new PrismaClient();

function nfkcNameKey(name) {
  return String(name ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/臺/g, '台').toLowerCase();
}

function classMarkers(name) {
  const n = String(name ?? '');
  const markers = [];
  if (/累積/.test(n)) markers.push('累積');
  if (/配息/.test(n)) markers.push('配息');
  for (const cls of ['A類','B類','N類','I類','A股','B股']) if (n.includes(cls)) markers.push(cls);
  return markers;
}

async function fetchSitcaRows() {
  const res = await fetch('https://www.sitca.org.tw/MemberK0000/F/03/nav.csv', {
    headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const text = await res.text();
  const parsed = Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
  const rows = [];
  for (const row of parsed.data) {
    const taxId = row['基金統編']?.trim();
    const name = row['基金名稱']?.trim();
    const navRaw = row['基金淨值']?.trim();
    const rawDate = row['日期']?.trim();
    const currency = row['幣別']?.trim();
    if (!taxId || !name || !navRaw || !rawDate) continue;
    if (!/^\d{8}$/.test(rawDate)) continue;
    const nav = Number(navRaw);
    if (!Number.isFinite(nav) || nav <= 0) continue;
    rows.push({ taxId, name, nav, currency, navDate: `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}` });
  }
  return rows;
}

const rows = await fetchSitcaRows();
const funds = await prisma.$queryRawUnsafe(`SELECT id, code, name, currency, latest_nav, latest_nav_date FROM funds WHERE currency IS NOT NULL`);

const byCode = new Map();
for (const f of funds) if (f.code) byCode.set(f.code, f);
const byName = new Map();
for (const f of funds) {
  const key = nfkcNameKey(f.name);
  if (!byName.has(key)) byName.set(key, []);
  byName.get(key).push(f);
}

const matched = [];
const unmatched = [];
for (const row of rows) {
  const hit = byCode.get(row.taxId);
  if (hit) { matched.push({ row, fund: hit, matchedBy: 'CODE' }); continue; }
  const nameHits = byName.get(nfkcNameKey(row.name));
  if (nameHits && nameHits.length === 1) { matched.push({ row, fund: nameHits[0], matchedBy: 'NAME' }); continue; }
  unmatched.push(row);
}

console.log(`Total rows: ${rows.length}, matched: ${matched.length} (CODE=${matched.filter(m=>m.matchedBy==='CODE').length}, NAME=${matched.filter(m=>m.matchedBy==='NAME').length}), unmatched: ${unmatched.length}`);

// --- b. currency mismatch ---
const currMismatch = matched.filter(m => m.row.currency && m.fund.currency && m.row.currency !== m.fund.currency);
console.log(`\n=== b1. Currency mismatch (SITCA row currency vs funds.currency) ===`);
console.log(`count: ${currMismatch.length} / ${matched.length}`);
for (const m of currMismatch.slice(0, 10)) {
  console.log(`  SITCA: ${m.row.name} cur=${m.row.currency} nav=${m.row.nav} | DB: ${m.fund.name} cur=${m.fund.currency} code=${m.fund.code}`);
}

// distinct SITCA currency values seen, for sanity
const sitcaCurrencies = new Set(rows.map(r => r.currency));
console.log(`\nDistinct SITCA currency values: ${[...sitcaCurrencies].join(', ')}`);
const dbCurrencies = new Set(funds.map(f => f.currency));
console.log(`Distinct funds.currency values (non-null): ${[...dbCurrencies].slice(0,20).join(', ')}`);

// --- b2. class marker mismatch ---
const classMismatch = matched.filter(m => {
  const a = classMarkers(m.row.name).sort().join(',');
  const b = classMarkers(m.fund.name).sort().join(',');
  return a !== b;
});
console.log(`\n=== b2. Share-class marker mismatch (累積/配息/A類/B類/N類/I類 in SITCA name vs DB name) ===`);
console.log(`count: ${classMismatch.length} / ${matched.length}`);
for (const m of classMismatch.slice(0, 10)) {
  console.log(`  SITCA: "${m.row.name}" [${classMarkers(m.row.name).join('+')||'none'}] | DB: "${m.fund.name}" [${classMarkers(m.fund.name).join('+')||'none'}] code=${m.fund.code}`);
}

const safeCount = matched.length - currMismatch.length - classMismatch.filter(m => !currMismatch.includes(m)).length;
console.log(`\n=== e. Safe-to-write estimate ===`);
const unsafeIds = new Set([...currMismatch, ...classMismatch].map(m => m.fund.id + '|' + m.row.taxId));
console.log(`matched: ${matched.length}, excluded (currency or class mismatch, deduped): ${unsafeIds.size}, safe: ${matched.length - unsafeIds.size}`);

await prisma.$disconnect();
