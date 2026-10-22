import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
for (const j of ['MARKET_CLOSE_SYNC_SHADOW','ETF_RETURNS_SYNC','US_FUND_NAV_SYNC','SITCA_NAV_SYNC']) {
  const r = await prisma.$queryRawUnsafe(`SELECT status, error, details->>'write_error_count' we FROM production_scheduler_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 1`, j);
  console.log(j, JSON.stringify(r));
}
await prisma.$disconnect();
