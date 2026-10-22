import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const run = await prisma.$queryRawUnsafe(`
  SELECT to_char(started_at,'YYYY-MM-DD HH24:MI:SS') started, status, error, details
  FROM production_scheduler_runs WHERE job_id='OFFSHORE_NAV_SYNC' ORDER BY started_at DESC LIMIT 1
`);
console.log(JSON.stringify(run, null, 1));
await prisma.$disconnect();
