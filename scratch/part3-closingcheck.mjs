import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);

// market-close-sync run status
const runs = await prisma.$queryRawUnsafe(`
  SELECT to_char(started_at,'YYYY-MM-DD HH24:MI:SS') started, status, error, details
  FROM production_scheduler_runs WHERE job_id='MARKET_CLOSE_SYNC_SHADOW' ORDER BY started_at DESC LIMIT 3
`);
console.log('Recent market-close-sync runs:', JSON.stringify(runs, null, 1));
await prisma.$disconnect();
