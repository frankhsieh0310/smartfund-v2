import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';
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
const parsed = Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
const byTaxId = new Map();
for (const row of parsed.data) {
  const taxId = row['基金統編']?.trim();
  const navRaw = row['基金淨值']?.trim();
  const rawDate = row['日期']?.trim();
  if (!taxId || !navRaw || !rawDate || !/^\d{8}$/.test(rawDate)) continue;
  const nav = Number(navRaw);
  if (!Number.isFinite(nav) || nav <= 0) continue;
  byTaxId.set(taxId, { name: row['基金名稱']?.trim(), currency: row['幣別']?.trim(), company: row['公司名稱']?.trim(), typeCode: row['類型代號']?.trim() });
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
console.log(`Unmatched count: ${unmatched.length}`);

let known = 0, unknown = 0;
const byTypeCount = {};
for (const u of unmatched) {
  const typeName = TYPE_MAP[u.typeCode];
  if (typeName) { known++; byTypeCount[typeName] = (byTypeCount[typeName]||0)+1; }
  else { unknown++; console.log(`UNKNOWN type code: ${u.typeCode} for ${u.name}`); }
}
console.log(`\nMapped to known type: ${known}, unmapped: ${unknown}`);
console.log('\nBreakdown by type:', JSON.stringify(byTypeCount, null, 1));
await prisma.$disconnect();
