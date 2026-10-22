import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';
import fs from 'node:fs';
const prisma = new PrismaClient();

// Correct test per the user's own wording: "基金名稱含有『對應』幣別字樣" means the name contains the
// marker THAT CORRESPONDS TO SITCA's row currency specifically -- not "the first currency marker found
// anywhere in the name" (which picks up a hedged class's BASE currency instead of its hedge currency).
const SITCA_CCY_TO_MARKER = {
  USD: /美元|美金/, CNY: /人民幣/, JPY: /日圓|日幣/, AUD: /澳幣/, ZAR: /南非幣/,
  EUR: /歐元/, HKD: /港幣/, GBP: /英鎊/, CAD: /加幣|加拿大幣/, NZD: /紐幣|紐西蘭幣/,
  CHF: /瑞士法郎/, SGD: /新加坡幣/,
};

const res = await fetch('https://www.sitca.org.tw/MemberK0000/F/03/nav.csv', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
const text = await res.text();
const parsed = Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
const byTaxId = new Map();
for (const row of parsed.data) {
  const taxId = row['基金統編']?.trim();
  const name = row['基金名稱']?.trim();
  const navRaw = row['基金淨值']?.trim();
  const rawDate = row['日期']?.trim();
  const currency = row['幣別']?.trim();
  if (!taxId || !name || !navRaw || !rawDate || !/^\d{8}$/.test(rawDate)) continue;
  const nav = Number(navRaw);
  if (!Number.isFinite(nav) || nav <= 0) continue;
  byTaxId.set(taxId, { name, nav, currency, navDate: `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}` });
}

const funds = await prisma.$queryRawUnsafe(`SELECT id, code, name, currency FROM funds WHERE currency = 'TWD'`);
const byCode = new Map(funds.map(f => [f.code, f]));
function nfkcNameKey(name) { return String(name ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/臺/g, '台').toLowerCase(); }
const byName = new Map();
for (const f of funds) { const k = nfkcNameKey(f.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(f); }

const matched = [];
for (const [taxId, row] of byTaxId) {
  const hit = byCode.get(taxId);
  if (hit) { matched.push({ fund: hit, row }); continue; }
  const nh = byName.get(nfkcNameKey(row.name));
  if (nh && nh.length === 1) matched.push({ fund: nh[0], row });
}

let bothConditions = 0, onlyCurrencyMismatch = 0, onlyNameImplies = 0, twdSitcaRows = 0;
const bothListFull = [];
const onlyCurrencyList = [];

for (const m of matched) {
  const currencyMismatch = m.row.currency !== m.fund.currency; // fund.currency always TWD here
  if (m.row.currency === 'TWD') { twdSitcaRows++; continue; } // SITCA itself says TWD -> no fix needed, not a mismatch case we care about
  const marker = SITCA_CCY_TO_MARKER[m.row.currency];
  const nameContainsCorrespondingMarker = marker ? marker.test(m.fund.name) : false;

  if (currencyMismatch && nameContainsCorrespondingMarker) {
    bothConditions++;
    bothListFull.push({ id: m.fund.id, code: m.fund.code, name: m.fund.name, oldCurrency: m.fund.currency, newCurrency: m.row.currency, sitcaNav: m.row.nav, sitcaNavDate: m.row.navDate });
  } else if (currencyMismatch && !nameContainsCorrespondingMarker) {
    onlyCurrencyMismatch++;
    if (onlyCurrencyList.length < 15) onlyCurrencyList.push({ code: m.fund.code, name: m.fund.name, sitcaCurrency: m.row.currency });
  }
}

console.log(`Total matched: ${matched.length}, of which SITCA currency=TWD (excluded, no fix needed): ${twdSitcaRows}`);
console.log(`\nBoth conditions met (currency mismatch AND name contains the CORRESPONDING currency marker): ${bothConditions}`);
console.log(`\nOnly currency mismatch, name does NOT contain the corresponding marker (excluded from fix, needs manual review): ${onlyCurrencyMismatch}`);
console.log(JSON.stringify(onlyCurrencyList, null, 1));

fs.writeFileSync('scratch/stepA4-both-conditions-fulllist.json', JSON.stringify(bothListFull, null, 1));
console.log(`\nSaved full both-conditions list (${bothListFull.length} rows) to scratch/stepA4-both-conditions-fulllist.json`);

// breakdown by target currency
const byTargetCcy = {};
for (const r of bothListFull) byTargetCcy[r.newCurrency] = (byTargetCcy[r.newCurrency]||0)+1;
console.log('\nBreakdown by target currency:', JSON.stringify(byTargetCcy));

await prisma.$disconnect();
