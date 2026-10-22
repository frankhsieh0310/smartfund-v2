import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL ?? process.env.DIRECT_URL } },
});

async function main(): Promise<void> {
  const settings = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT current_setting('transaction_read_only') AS transaction_read_only, current_setting('default_transaction_read_only') AS default_transaction_read_only, current_setting('statement_timeout') AS statement_timeout`);
  const lockActivity = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT a.pid, a.state, a.wait_event_type, a.wait_event, a.xact_start, a.query_start, pg_blocking_pids(a.pid) AS blocking_pids, left(a.query, 240) AS query FROM pg_stat_activity a WHERE a.datname=current_database() AND (a.query ILIKE '%industry_chain_%' OR cardinality(pg_blocking_pids(a.pid))>0) ORDER BY a.query_start`);
  const schemaObjects = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT 'INDEX' AS kind, indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname='public' AND tablename='industry_chain_industries' UNION ALL SELECT 'TRIGGER', tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='industry_chain_industries'::regclass AND NOT tgisinternal UNION ALL SELECT 'CONSTRAINT', conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='industry_chain_industries'::regclass ORDER BY kind, name`);
  const [checkpoint, summary, roles, canaries, quality] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT source, status, attempts, current_industry_id, jsonb_array_length(discovered_ids) AS discovered, jsonb_array_length(completed_ids) AS completed, started_at, updated_at, completed_at, last_error FROM industry_chain_import_checkpoints WHERE source='TPEx Industry Chain Information Platform'`),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT (SELECT count(*) FROM industry_chain_industries) AS industries, (SELECT count(*) FROM industry_chain_nodes) AS nodes, (SELECT count(*) FROM industry_chain_memberships WHERE active) AS memberships, (SELECT count(*) FROM industry_chain_evidence WHERE verification_status='OFFICIAL') AS evidence, (SELECT count(DISTINCT stock_id) FROM industry_chain_memberships WHERE active AND stock_id IS NOT NULL) AS mapped_stocks, (SELECT count(*) FROM industry_chain_memberships WHERE active AND mapping_status='UNMAPPED') AS unmapped, (SELECT count(*) FROM industry_chain_memberships WHERE active AND mapping_status='AMBIGUOUS') AS ambiguous`),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT n.chain_stage, count(*) AS memberships FROM industry_chain_memberships m JOIN industry_chain_nodes n ON n.id=m.industry_node_id WHERE m.active GROUP BY n.chain_stage ORDER BY n.chain_stage`),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT m.official_ticker, count(DISTINCT i.id) AS chains, array_agg(DISTINCT n.chain_stage) AS roles, bool_or(m.stock_id IS NOT NULL) AS stock_mapped, bool_or(sl.security_id IS NOT NULL) AS security_mapped FROM industry_chain_memberships m JOIN industry_chain_nodes n ON n.id=m.industry_node_id JOIN industry_chain_industries i ON i.id=n.industry_id LEFT JOIN stock_security_links sl ON sl.stock_id=m.stock_id WHERE m.active AND m.official_ticker IN ('2330','2303','2454') GROUP BY m.official_ticker ORDER BY m.official_ticker`),
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT (SELECT count(*) FROM (SELECT source_key FROM industry_chain_memberships GROUP BY source_key HAVING count(*)>1) d) AS duplicate_memberships, (SELECT count(*) FROM industry_chain_memberships m LEFT JOIN stocks s ON s.id=m.stock_id WHERE m.stock_id IS NOT NULL AND s.id IS NULL) AS orphan_stock_links, (SELECT count(*) FROM industry_chain_memberships WHERE mapping_status='AMBIGUOUS') AS ambiguous_persisted`),
  ]);
  console.log(JSON.stringify(
    { settings: settings[0], lockActivity, schemaObjects, checkpoint: checkpoint[0] ?? null, summary: summary[0], roles, canaries, quality: quality[0] },
    (_key, value) => typeof value === "bigint" ? Number(value) : value,
    2,
  ));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
