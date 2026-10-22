import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const r = await prisma.$queryRawUnsafe(`
  SELECT relname, n_live_tup, n_dead_tup,
    round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
    pg_size_pretty(pg_total_relation_size(relid)) total_size
  FROM pg_stat_user_tables WHERE n_dead_tup > 100000
  ORDER BY n_dead_tup DESC LIMIT 15
`);
console.log(JSON.stringify(r, (k,v)=>typeof v==='bigint'?v.toString():v, 1));
await prisma.$disconnect();
