import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import Papa from 'papaparse';
const prisma = new PrismaClient();

const csvText = fs.readFileSync('scratch/item2-tdcc-offshore-yahoo-mapping.csv', 'utf8');
const rows = Papa.parse(csvText, { header: true, skipEmptyLines: true }).data;

// Eligible = exact name match AND not flagged currency-inconsistent AND not flagged class-inconsistent.
// currency_consistent/class_consistent are 'true'/'false'/'' (empty = null, no markers found to compare -- treat as OK, not a flag)
const eligible = rows.filter(r =>
  r.exact_match === 'true' &&
  r.currency_consistent !== 'false' &&
  r.class_consistent !== 'false'
);
console.log(`Eligible (exact match, no currency/class flag): ${eligible.length} / ${rows.length}`);

const funds = await prisma.$queryRawUnsafe(`SELECT id, code FROM funds WHERE data_provider='tdcc-offshore'`);
const byCode = new Map(funds.map(f => [f.code, f.id]));

const mapping = [];
let missingFundId = 0;
for (const r of eligible) {
  const fundId = byCode.get(r.db_code);
  if (!fundId) { missingFundId++; continue; }
  mapping.push({ fundId, code: r.db_code, yahooFundId: r.yahoo_fund_id });
}
console.log(`Mapping entries with resolvable DB fund id: ${mapping.length} (missing: ${missingFundId})`);

fs.writeFileSync('scratch/item3-mapping-seed.json', JSON.stringify(mapping, null, 1));
console.log('Saved to scratch/item3-mapping-seed.json');
await prisma.$disconnect();
