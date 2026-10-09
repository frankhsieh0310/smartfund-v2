const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const hk = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS canonical_count,
      count(*) FILTER (WHERE isin IS NOT NULL)::int AS isin_count,
      count(*) FILTER (WHERE ticker IS NOT NULL)::int AS ticker_count,
      count(*) FILTER (WHERE exchange IS NOT NULL)::int AS exchange_count,
      count(*) FILTER (WHERE ticker IS NOT NULL AND exchange IS NOT NULL)::int AS mapping_capable_count
    FROM securities
    WHERE upper(coalesce(exchange,'')) IN ('HKEX','XHKG','SEHK')
       OR upper(coalesce(country,'')) IN ('HK','HKG','HONG KONG')`);
  const current = await prisma.$queryRawUnsafe(`
    WITH verified AS (
      SELECT * FROM index_constituent_snapshots WHERE verification_status='VERIFIED_OFFICIAL'
    ), latest AS (
      SELECT DISTINCT ON(index_id) id,index_id,effective_date,constituent_count,known_weight_count,known_weight_sum,checksum
      FROM verified ORDER BY index_id,effective_date DESC,retrieved_at DESC
    )
    SELECT l.index_id,l.effective_date,l.constituent_count,l.known_weight_count,l.known_weight_sum,l.checksum,
      count(c.id)::int AS rows,count(c.security_id)::int AS mapped,
      count(*) FILTER (WHERE c.ticker IS NOT NULL)::int AS source_identity_ready
    FROM latest l JOIN index_constituents c ON c.snapshot_id=l.id
    GROUP BY l.index_id,l.effective_date,l.constituent_count,l.known_weight_count,l.known_weight_sum,l.checksum
    ORDER BY l.index_id`);
  const historical = await prisma.$queryRawUnsafe(`
    SELECT index_id,effective_date,constituent_count,known_weight_count,known_weight_sum,checksum,
      verification_status,completeness_status
    FROM index_constituent_snapshots WHERE verification_status='VERIFIED_OFFICIAL'
    ORDER BY index_id,effective_date`);
  const events = await prisma.$queryRawUnsafe(`
    SELECT event_type,count(*)::int AS count FROM index_constituent_events GROUP BY event_type ORDER BY event_type`);
  const revisions = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS count FROM index_constituent_snapshots
    WHERE completeness_status='SUPERSEDED' OR verification_status='SUPERSEDED'`);
  console.log(JSON.stringify({ hk, current, historical, events, revisions }, null, 2));
}

main().finally(() => prisma.$disconnect());
