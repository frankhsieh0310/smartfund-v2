import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const run = await prisma.$queryRawUnsafe(`
  SELECT to_char(started_at,'HH24:MI:SS') started, details->'markets' markets FROM production_scheduler_runs WHERE job_id='MARKET_CLOSE_SYNC_SHADOW' ORDER BY started_at DESC LIMIT 1
`);
const hk = run[0].markets.find(m => m.jobId === 'hong-kong-yahoo-daily');
console.log('run started:', run[0].started);
console.log('HK:', JSON.stringify(hk, null, 1));
await prisma.$disconnect();
