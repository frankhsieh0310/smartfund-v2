import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);

const stats = await prisma.$queryRawUnsafe(`
  SELECT relname, n_tup_ins, n_tup_upd, n_tup_del, last_autovacuum, last_vacuum
  FROM pg_stat_user_tables WHERE relname IN ('option_observations','stock_history','stock_technical','fund_history')
`);
console.log(JSON.stringify(stats, (k,v)=>typeof v==='bigint'?v.toString():v, 1));

const dbstats = await prisma.$queryRawUnsafe(`SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()`);
console.log('stats_reset:', JSON.stringify(dbstats));

const idx = await prisma.$queryRawUnsafe(`SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) sz FROM pg_indexes WHERE tablename='option_observations'`);
console.log('option_observations indexes:', JSON.stringify(idx));
await prisma.$disconnect();
