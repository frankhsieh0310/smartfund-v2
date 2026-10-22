import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const codes = ['0150','ABILFAUSD','AGIF-JPI','HEN25','IE00B8HXK965','JAJHBTU','LU0080998981','LU0299357342','LU1883862531','SKFS'];
const rows = await prisma.$queryRawUnsafe(`SELECT code, latest_nav::text, latest_nav_date FROM funds WHERE code = ANY($1::text[])`, codes);
for (const r of rows) console.log(r.code, r.latest_nav, r.latest_nav_date?.toISOString?.().slice(0,10));

for (const j of ['MARKET_CLOSE_SYNC_SHADOW','ETF_RETURNS_SYNC','US_FUND_NAV_SYNC','SITCA_NAV_SYNC']) {
  const run = await prisma.$queryRawUnsafe(`SELECT status, error, details->>'write_error_count' we FROM production_scheduler_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 1`, j);
  console.log(j, JSON.stringify(run));
}
await prisma.$disconnect();
