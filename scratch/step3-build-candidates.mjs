import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';
import fs from 'node:fs';
const prisma = new PrismaClient();

const SITCA_CCY_TO_MARKER = {
  USD: /美元|美金/, CNY: /人民幣/, JPY: /日圓|日幣/, AUD: /澳幣/, ZAR: /南非幣/,
  EUR: /歐元/, HKD: /港幣/, GBP: /英鎊/, CAD: /加幣|加拿大幣/, NZD: /紐幣|紐西蘭幣/,
  CHF: /瑞士法郎/, SGD: /新加坡幣/,
};

const res = await fetch('https://www.sitca.org.tw/MemberK0000/F/03/nav.csv', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
const text = await res.text();
const parsed = Papa.parse(text.replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: true });
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

// A4 "both conditions" set: 2,025 currency-correction candidates
const candidates = [];
for (const m of matched) {
  if (m.row.currency === 'TWD') continue;
  const marker = SITCA_CCY_TO_MARKER[m.row.currency];
  if (marker && marker.test(m.fund.name)) {
    candidates.push({ id: m.fund.id, code: m.fund.code, name: m.fund.name, oldCurrency: m.fund.currency, newCurrency: m.row.currency });
  }
}
console.log(`A4 currency-correction candidates: ${candidates.length} (expect 2025)`);

// 34 "新台幣"/"新臺幣" -> 'TWD' normalization set (currency NOT 'TWD' under WHERE filter used above,
// so re-query separately without the currency='TWD' restriction)
const variantRows = await prisma.$queryRawUnsafe(`
  SELECT id, code, name, currency FROM funds
  WHERE is_active=true AND currency IN ('新台幣','新臺幣') AND COALESCE(data_provider,'') NOT IN ('yahoo','SEC')
`);
console.log(`新台幣/新臺幣 -> TWD normalization candidates: ${variantRows.length} (expect 34)`);
const variantCandidates = variantRows.map(f => ({ id: f.id, code: f.code, name: f.name, oldCurrency: f.currency, newCurrency: 'TWD' }));

const all = [...candidates, ...variantCandidates];
console.log(`\nTotal combined UPDATE candidates: ${all.length} (expect 2059)`);

// sanity: no id appears twice
const idSet = new Set(all.map(r => r.id));
console.log(`Distinct ids: ${idSet.size} (should equal ${all.length})`);

const csvHeader = 'id,code,name,old_currency,new_currency';
const csvLines = all.map(r => [r.id, r.code, r.name, r.oldCurrency, r.newCurrency].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
const csvContent = [csvHeader, ...csvLines].join('\n');
fs.writeFileSync('C:\\Users\\User\\Desktop\\smartfund-backup-etf-20261010\\funds-currency-fix-20261012.csv', csvContent);
console.log(`\nBackup CSV written: C:\\Users\\User\\Desktop\\smartfund-backup-etf-20261010\\funds-currency-fix-20261012.csv`);

fs.writeFileSync('scratch/step3-final-candidates.json', JSON.stringify(all, null, 1));
await prisma.$disconnect();
