import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 20000`);

const tables = await prisma.$queryRawUnsafe(`
  SELECT
    schemaname, relname AS table_name,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    pg_total_relation_size(relid) AS total_bytes,
    pg_size_pretty(pg_relation_size(relid)) AS table_size,
    pg_size_pretty(pg_indexes_size(relid)) AS index_size,
    n_live_tup, n_dead_tup
  FROM pg_stat_user_tables
  ORDER BY pg_total_relation_size(relid) DESC
  LIMIT 20
`);
console.log(JSON.stringify(tables, (k,v)=>typeof v==='bigint'?v.toString():v, 1));
await prisma.$disconnect();
