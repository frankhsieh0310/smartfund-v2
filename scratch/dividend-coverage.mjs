import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 10000`);

const etfDist = await prisma.$queryRawUnsafe(`
  SELECT count(DISTINCT etf_id)::int distinct_etfs, count(*)::int total_rows, max(ex_date) max_ex_date, max(created_at) max_created
  FROM etf_distribution_events
`).catch(e => ({error: e.message}));
console.log('etf_distribution_events:', JSON.stringify(etfDist));

const fundDist = await prisma.$queryRawUnsafe(`
  SELECT count(DISTINCT fund_id)::int distinct_funds, count(*)::int total_rows, max(ex_date) max_ex_date
  FROM fund_distribution_observations
`).catch(e => ({error: e.message}));
console.log('fund_distribution_observations:', JSON.stringify(fundDist));

const dist = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM distributions`).catch(e => ({error: e.message}));
console.log('distributions table count:', JSON.stringify(dist));

const ca = await prisma.$queryRawUnsafe(`SELECT distribution_type, count(*)::int n FROM corporate_actions GROUP BY distribution_type ORDER BY n DESC LIMIT 10`).catch(e => ({error: e.message}));
console.log('corporate_actions by type:', JSON.stringify(ca));

await prisma.$disconnect();
