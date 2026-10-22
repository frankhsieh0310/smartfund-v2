import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const hk = await prisma.$queryRawUnsafe(`SELECT latest_price::text, price_updated_at FROM etfs WHERE code='2800.HK'`);
console.log('2800.HK:', JSON.stringify(hk));
const inst = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM institutional_daily WHERE date='2026-10-12'`);
console.log('institutional 10/12 count:', JSON.stringify(inst));
const run = await prisma.$queryRawUnsafe(`
  SELECT to_char(started_at,'HH24:MI:SS') started, details->'markets' markets FROM production_scheduler_runs WHERE job_id='MARKET_CLOSE_SYNC_SHADOW' ORDER BY started_at DESC LIMIT 1
`);
const hkJob = run[0].markets.find(m => m.jobId === 'hong-kong-yahoo-daily');
console.log('latest MCS run:', run[0].started, 'HK job:', JSON.stringify(hkJob));
await prisma.$disconnect();
