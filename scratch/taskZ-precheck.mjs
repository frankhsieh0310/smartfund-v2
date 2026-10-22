import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';

const prisma = new PrismaClient();

function nfkcNameKey(name) {
  return String(name ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/臺/g, '台').toLowerCase();
}

async function fetchSitcaRows() {
  const res = await fetch('https://www.sitca.org.tw/MemberK0000/F/03/nav.csv', {
    headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const text = await res.text();
  const parsed = Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
  const rawRows = parsed.data;
  const rows = [];
  for (const row of rawRows) {
    const taxId = row['基金統編']?.trim();
    const name = row['基金名稱']?.trim();
    const navRaw = row['基金淨值']?.trim();
    const rawDate = row['日期']?.trim();
    const currency = row['幣別']?.trim();
    const fundCode = row['基金代號']?.trim();
    const typeCode = row['類型代號']?.trim();
    const beneficiaryCode = row['受益憑證代號']?.trim();
    if (!taxId || !name || !navRaw || !rawDate) continue;
    if (!/^\d{8}$/.test(rawDate)) continue;
    const nav = Number(navRaw);
    if (!Number.isFinite(nav) || nav <= 0) continue;
    rows.push({
      taxId, name, nav, currency, fundCode, typeCode, beneficiaryCode,
      navDate: `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`,
    });
  }
  return { rawCount: rawRows.length, rows };
}

const { rawCount, rows } = await fetchSitcaRows();
console.log(`=== RAW CSV ROWS (incl. header-parse artifacts): ${rawCount} ===`);
console.log(`=== VALID PARSED ROWS (after date/nav/field checks): ${rows.length} ===`);

// --- a. Uniqueness ---
const byTaxId = new Map();
for (const r of rows) {
  if (!byTaxId.has(r.taxId)) byTaxId.set(r.taxId, []);
  byTaxId.get(r.taxId).push(r);
}
const dupTaxIds = [...byTaxId.entries()].filter(([, v]) => v.length > 1);
console.log(`\n=== a. SITCA 基金統編 uniqueness ===`);
console.log(`distinct taxIds: ${byTaxId.size}, taxIds with >1 row: ${dupTaxIds.length}, total rows affected: ${dupTaxIds.reduce((s,[,v])=>s+v.length,0)}`);
console.log('Examples (first 5):');
for (const [taxId, group] of dupTaxIds.slice(0, 5)) {
  console.log(`  taxId=${taxId}: ${group.map(g => `${g.name}(${g.currency},nav=${g.nav})`).join(' | ')}`);
}

const funds = await prisma.$queryRawUnsafe(`SELECT id, code, name, currency FROM funds WHERE currency = 'TWD'`);
const byCode = new Map();
for (const f of funds) {
  if (!f.code) continue;
  if (!byCode.has(f.code)) byCode.set(f.code, []);
  byCode.get(f.code).push(f);
}
const dupCodes = [...byCode.entries()].filter(([, v]) => v.length > 1);
console.log(`\nfunds.code uniqueness (TWD funds): distinct codes: ${byCode.size}, codes with >1 fund: ${dupCodes.length}`);
for (const [code, group] of dupCodes.slice(0, 5)) {
  console.log(`  code=${code}: ${group.map(g => `${g.name}(id=${g.id})`).join(' | ')}`);
}

await prisma.$disconnect();
