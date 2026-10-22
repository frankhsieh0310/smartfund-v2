import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const prisma = new PrismaClient();

const TYPE_MAP = {
  'AA1': '國內投資股票型', 'AA2': '跨國投資股票型',
  'AB1': '國內投資平衡型', 'AB2': '跨國投資平衡型',
  'AC12': '國內投資固定收益一般債券型', 'AC21': '跨國投資固定收益一般債券型',
  'AC22': '金融資產證券化型', 'AC23': '非投資等級債券型',
  'AD1': '國內投資貨幣市場基金', 'AD2': '跨國投資貨幣市場基金',
  'AE1': '國內投資組合型', 'AE21': '跨國投資組合型_股票型', 'AE22': '跨國投資組合型_債券型',
  'AE23': '跨國投資組合型_平衡型', 'AE24': '跨國投資組合型_其他',
  'AF': '保本型', 'AG': '不動產證券化型',
  'AH11': '國內投資指數股票型_股票型', 'AH12': '國內投資指數股票型_債券型',
  'AH13': '國內投資指數股票型_槓桿型/反向型', 'AH14': '國內投資指數股票型_其他', 'AH15': '國內投資指數股票型_平衡型',
  'AH21': '跨國投資指數股票型_股票型', 'AH22': '跨國投資指數股票型_債券型',
  'AH23': '跨國投資指數股票型_槓桿型/反向型_股票', 'AH24': '跨國投資指數股票型_槓桿型/反向型_債券',
  'AH25': '跨國投資指數股票型_不動產證券化/其他', 'AH26': '跨國投資指數股票型_平衡型',
  'AI1': '國內投資指數型', 'AI2': '跨國投資指數型',
  'AJ1': '國內投資多重資產型', 'AJ2': '跨國投資多重資產型',
  'AK11': '國內投資指數股票型基金之連結基金', 'AK12': '國內投資主動式交易所交易基金之連結基金',
  'AK21': '跨國投資指數股票型基金之連結基金', 'AK22': '跨國投資主動式交易所交易基金之連結基金',
  'AL11': '國內投資主動式交易所交易基金_股票型', 'AL12': '國內投資主動式交易所交易基金_債券型', 'AL19': '國內投資主動式交易所交易基金_其他',
  'AL21': '跨國投資主動式交易所交易基金_股票型', 'AL22': '跨國投資主動式交易所交易基金_債券型', 'AL29': '跨國投資主動式交易所交易基金_其他',
};

const res = await fetch('https://www.sitca.org.tw/MemberK0000/F/03/nav.csv', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
const text = await res.text();
const parsed = Papa.parse(text.replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: true });
const byTaxId = new Map();
for (const row of parsed.data) {
  const taxId = row['基金統編']?.trim();
  const navRaw = row['基金淨值']?.trim();
  const rawDate = row['日期']?.trim();
  if (!taxId || !navRaw || !rawDate || !/^\d{8}$/.test(rawDate)) continue;
  const nav = Number(navRaw);
  if (!Number.isFinite(nav) || nav <= 0) continue;
  byTaxId.set(taxId, {
    name: row['基金名稱']?.trim(), currency: row['幣別']?.trim(), company: row['公司名稱']?.trim(),
    typeCode: row['類型代號']?.trim(), nav, navDate: `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`,
  });
}

const funds = await prisma.$queryRawUnsafe(`SELECT id, code, name, currency FROM funds WHERE COALESCE(data_provider,'') NOT IN ('yahoo','SEC')`);
const byCode = new Map(funds.map(f => [f.code, f]));
function nfkcNameKey(name) { return String(name ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/臺/g, '台').toLowerCase(); }
const byName = new Map();
for (const f of funds) { const k = nfkcNameKey(f.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(f); }

const unmatched = [];
for (const [taxId, row] of byTaxId) {
  if (byCode.get(taxId)) continue;
  const nh = byName.get(nfkcNameKey(row.name));
  if (nh && nh.length === 1) continue;
  unmatched.push({ taxId, ...row });
}
console.log(`Unmatched count (candidates for new fund creation): ${unmatched.length}`);

// double-check: code (taxId) must not already exist in funds (unique constraint)
const existingCodes = await prisma.$queryRawUnsafe(`SELECT code FROM funds WHERE code = ANY($1::text[])`, unmatched.map(u => u.taxId));
if (existingCodes.length) {
  console.log(`WARNING: ${existingCodes.length} candidate codes already exist in funds table! Excluding them.`);
}
const existingCodeSet = new Set(existingCodes.map(r => r.code));

const newFunds = unmatched.filter(u => !existingCodeSet.has(u.taxId)).map(u => {
  const typeName = TYPE_MAP[u.typeCode] ?? null;
  return {
    id: randomUUID(), code: u.taxId, name: u.name, company: u.company, currency: u.currency,
    category: typeName, latest_nav: u.nav, latest_nav_date: u.navDate, data_provider: 'SITCA',
    last_nav_source: 'SITCA_FSC_OFFICIAL_DAILY_NAV_CSV',
  };
});
console.log(`Final new-fund insert candidates: ${newFunds.length}`);

const csvHeader = 'id,code,name,company,currency,category,latest_nav,latest_nav_date,data_provider,last_nav_source';
const csvLines = newFunds.map(f => [f.id, f.code, f.name, f.company, f.currency, f.category, f.latest_nav, f.latest_nav_date, f.data_provider, f.last_nav_source].map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(','));
const csvContent = [csvHeader, ...csvLines].join('\n');
fs.writeFileSync('C:\\Users\\User\\Desktop\\smartfund-backup-etf-20261010\\funds-new-177-20261012.csv', csvContent);
console.log('Backup CSV written: C:\\Users\\User\\Desktop\\smartfund-backup-etf-20261010\\funds-new-177-20261012.csv');

fs.writeFileSync('scratch/item4-newfunds-final.json', JSON.stringify(newFunds, null, 1));
await prisma.$disconnect();
