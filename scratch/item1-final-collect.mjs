import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);

const sitcaRun = await prisma.$queryRawUnsafe(`SELECT status, error, details->>'written' written FROM production_scheduler_runs WHERE job_id='SITCA_NAV_SYNC' ORDER BY started_at DESC LIMIT 1`);
console.log('sitca-nav-sync latest:', JSON.stringify(sitcaRun));

const inst = await prisma.$queryRawUnsafe(`
  SELECT ticker, foreign_net::text, trust_net::text, dealer_net::text FROM institutional_daily WHERE date='2026-10-12' AND ticker IN ('2330','2317','0050')
`);
console.log('institutional 10/12:', JSON.stringify(inst));

const hk = await prisma.$queryRawUnsafe(`SELECT latest_price::text, price_updated_at FROM etfs WHERE code='2800.HK'`);
console.log('2800.HK:', JSON.stringify(hk));

const pipelines = await Promise.all(['MARKET_CLOSE_SYNC_SHADOW','ETF_RETURNS_SYNC','US_FUND_NAV_SYNC'].map(j =>
  prisma.$queryRawUnsafe(`SELECT status, error, details->>'write_error_count' we FROM production_scheduler_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 1`, j)
));
console.log('pipelines:', JSON.stringify(pipelines));

await prisma.$disconnect();
