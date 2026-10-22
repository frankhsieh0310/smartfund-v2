import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);

const stats = await prisma.$queryRawUnsafe(`
  SELECT relname, n_tup_ins, n_tup_upd, n_tup_del, last_autovacuum, last_vacuum, stats_reset
  FROM pg_stat_user_tables WHERE relname IN ('option_observations','stock_history','stock_technical','fund_history')
`);
console.log(JSON.stringify(stats, (k,v)=>typeof v==='bigint'?v.toString():v, 1));

const idx = await prisma.$queryRawUnsafe(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename='option_observations'`);
console.log('indexes:', JSON.stringify(idx, null, 1));
await prisma.$disconnect();
