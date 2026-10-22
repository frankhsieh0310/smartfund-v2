const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const migration = '20260811013000_etf_distribution_events_additive';
const runtime = path.resolve('runtime', 'etf-distribution-v3');
const archive = path.join(runtime, 'archive');
const sources = [
  ['IVV', 'https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf'],
  ['AGG', 'https://www.ishares.com/us/products/239458/ishares-core-us-aggregate-bond-etf'],
];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const decode = value => value.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
function values(text, label) {
  const match = text.match(new RegExp(`"label":"${label}"[\\s\\S]{0,1600}?"value":\\[([^\\]]*)\\]`));
  return match ? match[1].split(',').map(v => v.trim().replace(/^"|"$/g, '')).filter(Boolean) : [];
}
function date(value) {
  const s = String(value);
  return /^\d{8}$/.test(s) ? new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00.000Z`) : null;
}
async function ensureApprovedTable() {
  const [{ exists }] = await prisma.$queryRaw`SELECT to_regclass('public.etf_distribution_events') IS NOT NULL AS exists`;
  if (exists) return 'ALREADY_PRESENT';
  const sql = fs.readFileSync(path.join('prisma', 'migrations', migration, 'migration.sql'), 'utf8');
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement);
  return 'APPLIED';
}
async function loadEvents(code, url, etfId) {
  const response = await fetch(url, { headers: { 'user-agent': 'SmartFund ETF distribution approved canary/1.0' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${code} HTTP ${response.status}`);
  const raw = await response.text();
  const digest = hash(raw);
  fs.mkdirSync(archive, { recursive: true });
  const archivePath = path.join(archive, `${code}-${digest.slice(0, 12)}.html`);
  if (!fs.existsSync(archivePath)) fs.writeFileSync(archivePath, raw);
  const text = decode(raw), ex = values(text, 'Ex-Date'), record = values(text, 'Record Date');
  const pay = values(text, 'Payable Date'), amount = values(text, 'Total Distribution');
  const count = Math.min(ex.length, record.length, pay.length, amount.length);
  const rows = Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(), etfId, shareClassId: 'PRIMARY', exDate: date(ex[i]), recordDate: date(record[i]),
    paymentDate: date(pay[i]), announcementDate: null, effectiveDate: date(ex[i]), amount: amount[i], currency: 'USD',
    distributionType: null, source: 'ISHARES_OFFICIAL_PRODUCT_DISTRIBUTIONS',
    sourceRecordId: hash(`${code}|${ex[i]}|${amount[i]}`), verificationStatus: 'SOURCE_VERIFIED',
  })).filter(row => row.exDate && row.recordDate && row.paymentDate && Number.isFinite(Number(row.amount)) && Number(row.amount) >= 0);
  return { rows, archivePath, digest };
}
async function ingest(rows) {
  return prisma.etfDistributionEvent.createMany({ data: rows, skipDuplicates: true });
}
async function main() {
  fs.mkdirSync(runtime, { recursive: true });
  const tableStatus = await ensureApprovedTable();
  const etfs = await prisma.etf.findMany({ where: { code: { in: sources.map(([code]) => code) } }, select: { id: true, code: true } });
  if (etfs.length !== 2) throw new Error(`Canonical ETF mapping expected 2, found ${etfs.length}`);
  const results = [];
  for (const [code, url] of sources) {
    const etf = etfs.find(item => item.code === code);
    const loaded = await loadEvents(code, url, etf.id);
    const first = await ingest(loaded.rows);
    const second = await ingest(loaded.rows);
    const readBack = await prisma.etfDistributionEvent.count({ where: { etfId: etf.id, source: 'ISHARES_OFFICIAL_PRODUCT_DISTRIBUTIONS' } });
    const duplicateGroups = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM (SELECT etf_id, share_class_id, ex_date, source, source_record_id, COUNT(*) FROM etf_distribution_events WHERE etf_id = $1 GROUP BY 1,2,3,4,5 HAVING COUNT(*) > 1) d`, etf.id);
    results.push({ code, sourceRows: loaded.rows.length, inserted: first.count, secondRunInserted: second.count, readBack, duplicateGroups: duplicateGroups[0].count, canonicalEtfId: etf.id, archivePath: loaded.archivePath, sourceSha256: loaded.digest });
  }
  const columns = await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='etf_distribution_events'`;
  const manifest = {
    task: 'ETF_V3_DISTRIBUTION_MIGRATION_CANARY_AND_FINAL_DEPTH_GATE_V1', migration, migrationApproval: true,
    tableStatus, schemaColumns: columns[0].count, canary: results,
    canaryStatus: results.every(r => r.sourceRows > 0 && r.readBack === r.sourceRows && r.secondRunInserted === 0 && r.duplicateGroups === 0) ? 'PASS' : 'FAIL',
    idempotency: results.every(r => r.secondRunInserted === 0) ? 'PASS_NO_OP' : 'FAIL',
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(runtime, 'distribution-migration-canary.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
