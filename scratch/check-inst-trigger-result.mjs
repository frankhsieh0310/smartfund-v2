import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const r = await prisma.$queryRawUnsafe(`
  SELECT to_char(started_at,'YYYY-MM-DD HH24:MI:SS') started, status, error, details
  FROM production_scheduler_runs WHERE job_id='INSTITUTIONAL_UPDATE' ORDER BY started_at DESC LIMIT 1
`);
console.log(JSON.stringify(r, null, 1));
const inst = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM institutional_daily WHERE date='2026-10-12'`);
console.log('institutional_daily 10/12 count:', JSON.stringify(inst));
await prisma.$disconnect();
