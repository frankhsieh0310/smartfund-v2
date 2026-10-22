import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const r = await prisma.$queryRawUnsafe(`
  SELECT to_char(started_at,'YYYY-MM-DD HH24:MI:SS') started, status, error, details->>'written' written, details->>'run_mode' mode
  FROM production_scheduler_runs WHERE job_id='OFFSHORE_NAV_SYNC' ORDER BY started_at DESC LIMIT 1
`);
console.log(JSON.stringify(r));
await prisma.$disconnect();
