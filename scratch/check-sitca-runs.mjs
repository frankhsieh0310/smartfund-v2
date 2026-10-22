import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const runs = await prisma.$queryRawUnsafe(`
  SELECT to_char(started_at,'YYYY-MM-DD HH24:MI') started, status, details->>'run_mode' run_mode, details->>'written' written, details->>'write_candidate_count' wc
  FROM production_scheduler_runs WHERE job_id = 'SITCA_NAV_SYNC' ORDER BY started_at DESC LIMIT 20
`);
console.log(JSON.stringify(runs, null, 1));
const anyWritten = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int n FROM production_scheduler_runs WHERE job_id='SITCA_NAV_SYNC' AND (details->>'written')::int > 0
`);
console.log('runs with written>0 via the actual deployed route:', JSON.stringify(anyWritten));
await prisma.$disconnect();
