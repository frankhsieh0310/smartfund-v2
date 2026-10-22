import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';

const prisma = new PrismaClient();

function nfkcNameKey(name) {
  return String(name ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/臺/g, '台').toLowerCase();
}

// Primary class marker only — ignore risk-disclaimer suffix text which often repeats "配息"/"累積"
// inside a parenthetical disclaimer unrelated to the actual share-class type.
function primaryClassMarker(name) {
  const n = String(name ?? '').split('(')[0]; // strip trailing disclaimer parenthetical
  if (/累積/.test(n)) return '累積';
  if (/配息/.test(n)) return '配息';
  for (const cls of ['A類','B類','N類','I類','A股','B股']) if (n.includes(cls)) return cls;
  return null;
}

async function fetchSitcaRows() {
  const res = await fetch('https://www.sitca.org.tw/MemberK0000/F/03/nav.csv', {
    headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000),
  });
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

// Currency: funds.currency is fund-family-level (verified NOT per-class), so this field disagreement
// is a genuine, systemic data-quality gap — but per the user's explicit rule, excluded from write anyway.
const currMismatch = matched.filter(m => m.row.currency === 'TWD' ? m.fund.currency !== 'TWD' && m.fund.currency !== '新台幣'
  : !['美元','USD'].includes(m.fund.currency) && m.row.currency !== 'TWD' ? true : false);
// Simpler: any case where SITCA says non-TWD but DB says TWD (the actual risk pattern), or both TWD but differ otherwise
const realCurrMismatch = matched.filter(m => {
  const sitcaIsTwd = m.row.currency === 'TWD';
  const dbIsTwd = m.fund.currency === 'TWD' || m.fund.currency === '新台幣';
  return sitcaIsTwd !== dbIsTwd;
});

console.log(`Total: ${rows.length}, matched: ${matched.length}, unmatched: ${unmatched.length}`);
console.log(`\n=== b1 (refined). SITCA non-TWD vs DB currency=TWD (the real risk pattern) ===`);
console.log(`count: ${realCurrMismatch.length} / ${matched.length}`);

const classMismatch = matched.filter(m => {
  const a = primaryClassMarker(m.row.name);
  const b = primaryClassMarker(m.fund.name);
  return a !== null && b !== null && a !== b;
});
console.log(`\n=== b2 (refined, primary marker only, disclaimer-suffix stripped). Genuine class mismatch ===`);
console.log(`count: ${classMismatch.length} / ${matched.length}`);
for (const m of classMismatch.slice(0, 15)) {
  console.log(`  SITCA: "${m.row.name}" [${primaryClassMarker(m.row.name)}] | DB: "${m.fund.name}" [${primaryClassMarker(m.fund.name)}] code=${m.fund.code}`);
}

const unsafeIds = new Set();
for (const m of realCurrMismatch) unsafeIds.add(m.fund.id);
for (const m of classMismatch) unsafeIds.add(m.fund.id);
console.log(`\n=== e (refined). Safe-to-write ===`);
console.log(`matched=${matched.length}, excluded(currency-risk or genuine-class-mismatch, deduped by fund)=${unsafeIds.size}, safe=${matched.length - unsafeIds.size}`);

// --- c. multi-class samples: 野村, 國泰, 元大 ---
console.log(`\n=== c. Multi-class fund samples (野村/國泰/元大, TWD+USD classes) ===`);
for (const company of ['野村', '國泰', '元大']) {
  const famCodes = new Map();
  for (const m of matched) {
    if (m.fund.name.includes(company)) {
      const base = m.fund.code?.slice(0, -1);
      if (!famCodes.has(base)) famCodes.set(base, []);
      famCodes.get(base).push(m);
    }
  }
  // find a family with both NTD and foreign-currency-named classes
  let picked = null;
  for (const [base, group] of famCodes) {
    if (group.length >= 2) {
      const hasForeign = group.some(g => /美元|美金|USD/.test(g.row.name));
      const hasTwd = group.some(g => /新台幣|TWD/.test(g.row.name) || !/美元|美金|日圓|日幣|USD/.test(g.row.name));
      if (hasForeign && group.length >= 2) { picked = { base, group }; break; }
    }
  }
  if (!picked) { console.log(`  [${company}] no multi-class(foreign+TWD) family found in matched set`); continue; }
  console.log(`  [${company}] family base code ${picked.base}:`);
  for (const m of picked.group) {
    console.log(`    SITCA: "${m.row.name}" nav=${m.row.nav} cur=${m.row.currency} | DB: "${m.fund.name}" cur=${m.fund.currency} code=${m.fund.code} DB_latest_nav=${m.fund.latest_nav} DB_latest_nav_date=${m.fund.latest_nav_date}`);
  }
}

await prisma.$disconnect();
