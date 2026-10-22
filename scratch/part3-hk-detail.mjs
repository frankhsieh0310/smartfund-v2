import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const run = await prisma.$queryRawUnsafe(`
  SELECT details->'markets' markets FROM production_scheduler_runs WHERE job_id='MARKET_CLOSE_SYNC_SHADOW' ORDER BY started_at DESC LIMIT 1
`);
const hk = run[0].markets.find(m => m.jobId === 'hong-kong-yahoo-daily');
const jp = run[0].markets.find(m => m.jobId === 'japan-yahoo-daily');
console.log('HK:', JSON.stringify(hk, null, 1));
console.log('JP:', JSON.stringify(jp, null, 1));
await prisma.$disconnect();
