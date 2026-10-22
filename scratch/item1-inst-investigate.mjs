import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 10000`);
const jobs = await prisma.$queryRawUnsafe(`
  SELECT job_id, count(*)::int n, max(started_at) last_run
  FROM production_scheduler_runs WHERE job_id ILIKE '%institutional%' GROUP BY job_id
`);
console.log('institutional-related scheduler jobs:', JSON.stringify(jobs));
await prisma.$disconnect();
