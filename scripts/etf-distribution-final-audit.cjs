const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const codes = ['IVV', 'AGG'];
  const rows = await prisma.$queryRawUnsafe(`
    SELECT e.code,
      COUNT(d.id)::int AS rows,
      MIN(d.ex_date)::text AS earliest,
      MAX(d.ex_date)::text AS latest,
      COUNT(DISTINCT d.ex_date)::int AS distinct_dates,
      COUNT(*) FILTER (WHERE d.amount < 0 OR d.currency IS NULL OR d.effective_date IS NULL)::int AS invalid_rows,
      COUNT(*) FILTER (WHERE d.source IS NULL OR d.source_record_id IS NULL OR d.verification_status IS NULL)::int AS missing_provenance
    FROM etfs e JOIN etf_distribution_events d ON d.etf_id=e.id
    WHERE e.code = ANY($1::text[]) GROUP BY e.code ORDER BY e.code`, codes);
  const duplicate = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM (SELECT etf_id, share_class_id, ex_date, source, source_record_id FROM etf_distribution_events GROUP BY 1,2,3,4,5 HAVING COUNT(*) > 1) x`);
  const orphan = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM etf_distribution_events d LEFT JOIN etfs e ON e.id=d.etf_id WHERE e.id IS NULL`);
  const ledger = await prisma.$queryRawUnsafe(`SELECT migration_name, finished_at IS NOT NULL AND rolled_back_at IS NULL AS applied FROM _prisma_migrations WHERE migration_name=$1`, '20260811013000_etf_distribution_events_additive');
  const result = { rows, duplicateKeys: duplicate[0].count, identityOrphans: orphan[0].count, ledger };
  const output = path.resolve('runtime', 'etf-distribution-v3', 'final-audit.json');
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
