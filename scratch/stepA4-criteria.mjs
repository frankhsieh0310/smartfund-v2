import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';
import fs from 'node:fs';
const prisma = new PrismaClient();

const CURRENCY_NAME_MARKERS = {
  USD: /美元|美金/,
  CNY: /人民幣/,
  JPY: /日圓|日幣/,
  AUD: /澳幣/,
  ZAR: /南非幣/,
  EUR: /歐元/,
  HKD: /港幣/,
  GBP: /英鎊/,
  CAD: /加幣|加拿大幣/,
  NZD: /紐幣|紐西蘭幣/,
  CHF: /瑞士法郎/,
  SGD: /新加坡幣/,
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

// reconstruct matched set same as route (code-first, name-fallback)
const matched = [];
for (const [taxId, row] of byTaxId) {
  const hit = byCode.get(taxId);
  if (hit) { matched.push({ fund: hit, row }); continue; }
  const nh = byName.get(nfkcNameKey(row.name));
  if (nh && nh.length === 1) matched.push({ fund: nh[0], row });
}

let bothConditions = 0, onlyCurrencyMismatch = 0, onlyNameImplies = 0;
const bothListFull = [];
const onlyCurrencyList = [];
const onlyNameList = [];

for (const m of matched) {
  const currencyMismatch = m.row.currency !== m.fund.currency; // fund.currency always TWD here
  const nameImpliedCcy = Object.entries(CURRENCY_NAME_MARKERS).find(([code, re]) => re.test(m.fund.name));
  const nameImplies = !!nameImpliedCcy;
  // does the implied currency from name actually match SITCA's row currency (sanity)?
  if (currencyMismatch && nameImplies) {
    bothConditions++;
    bothListFull.push({ id: m.fund.id, code: m.fund.code, name: m.fund.name, oldCurrency: m.fund.currency, newCurrency: m.row.currency, sitcaNav: m.row.nav });
  } else if (currencyMismatch && !nameImplies) {
    onlyCurrencyMismatch++;
    if (onlyCurrencyList.length < 10) onlyCurrencyList.push({ code: m.fund.code, name: m.fund.name, sitcaCurrency: m.row.currency });
  } else if (!currencyMismatch && nameImplies) {
    onlyNameImplies++;
    if (onlyNameList.length < 10) onlyNameList.push({ code: m.fund.code, name: m.fund.name, sitcaCurrency: m.row.currency, fundCurrency: m.fund.currency });
  }
}

console.log(`Total matched (TWD-tagged funds): ${matched.length}`);
console.log(`\nBoth conditions met (currency mismatch AND name implies currency): ${bothConditions}`);
console.log(`Only currency mismatch (name doesn't contain a currency marker): ${onlyCurrencyMismatch}`);
console.log(JSON.stringify(onlyCurrencyList, null, 1));
console.log(`\nOnly name implies currency (but SITCA currency happens to already equal funds.currency): ${onlyNameImplies}`);
console.log(JSON.stringify(onlyNameList, null, 1));

// sanity: within "both conditions", does the name-implied currency actually AGREE with SITCA's currency code?
const CCY_TO_SITCA = { USD: 'USD', CNY: 'CNY', JPY: 'JPY', AUD: 'AUD', ZAR: 'ZAR', EUR: 'EUR', HKD: 'HKD', GBP: 'GBP', CAD: 'CAD', NZD: 'NZD', CHF: 'CHF', SGD: 'SGD' };
let agree = 0, disagree = 0;
const disagreeList = [];
for (const m of matched) {
  const currencyMismatch = m.row.currency !== m.fund.currency;
  const nameImpliedCcy = Object.entries(CURRENCY_NAME_MARKERS).find(([code, re]) => re.test(m.fund.name));
  if (currencyMismatch && nameImpliedCcy) {
    const [ccyCode] = nameImpliedCcy;
    if (CCY_TO_SITCA[ccyCode] === m.row.currency) agree++;
    else { disagree++; if (disagreeList.length < 10) disagreeList.push({ code: m.fund.code, name: m.fund.name, nameImplies: ccyCode, sitcaCurrency: m.row.currency }); }
  }
}
console.log(`\nWithin "both conditions" set: name-implied currency AGREES with SITCA currency code: ${agree}, DISAGREES: ${disagree}`);
if (disagreeList.length) console.log(JSON.stringify(disagreeList, null, 1));

fs.writeFileSync('scratch/stepA4-both-conditions-fulllist.json', JSON.stringify(bothListFull, null, 1));
console.log(`\nSaved full both-conditions list (${bothListFull.length} rows) to scratch/stepA4-both-conditions-fulllist.json`);
await prisma.$disconnect();
