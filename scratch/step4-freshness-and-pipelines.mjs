import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 10000`);

// domestic fund freshness: within 3 trading days of today (2026-10-12), among non-yahoo/SEC funds
const fresh = await prisma.$queryRawUnsafe(`
  SELECT
    count(*)::int total,
    count(*) FILTER (WHERE latest_nav_date >= '2026-10-07')::int fresh_3bd
  FROM funds WHERE is_active=true AND COALESCE(data_provider,'') NOT IN ('yahoo','SEC')
`);
console.log('Domestic fund freshness (latest_nav_date >= 2026-10-07, ~3 trading days):', JSON.stringify(fresh));

for (const job of ['MARKET_CLOSE_SYNC_SHADOW', 'ETF_RETURNS_SYNC', 'US_FUND_NAV_SYNC']) {
  const r = await prisma.$queryRawUnsafe(`SELECT status, error, details->>'write_error_count' we FROM production_scheduler_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 1`, job);
  console.log(job, JSON.stringify(r));
}
await prisma.$disconnect();
