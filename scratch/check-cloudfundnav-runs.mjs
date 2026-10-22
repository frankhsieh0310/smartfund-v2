import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const runs = await prisma.$queryRawUnsafe(`
  SELECT job_id, count(*)::int n, min(started_at) mn, max(started_at) mx
  FROM production_scheduler_runs WHERE job_id ILIKE '%fund_nav%' OR job_id ILIKE '%FUND_NAV%'
  GROUP BY job_id
`);
console.log(JSON.stringify(runs, null, 1));
const sample = await prisma.$queryRawUnsafe(`
  SELECT job_id, to_char(started_at,'YYYY-MM-DD HH24:MI') started, status, details->>'matched' matched, details->>'nav_moved' nav_moved, details->>'history_written' hw
  FROM production_scheduler_runs WHERE job_id ILIKE '%CLOUD_FUND_NAV%' ORDER BY started_at DESC LIMIT 5
`);
console.log(JSON.stringify(sample, null, 1));
await prisma.$disconnect();
