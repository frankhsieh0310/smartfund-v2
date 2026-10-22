import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const idx = await prisma.$queryRawUnsafe(`
  SELECT s.relname AS table_name, s.indexrelname AS index_name, s.idx_scan,
         pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
         pg_relation_size(s.indexrelid) AS bytes
  FROM pg_stat_user_indexes s
  JOIN pg_index i ON i.indexrelid = s.indexrelid
  WHERE s.idx_scan = 0 AND NOT i.indisprimary AND NOT i.indisunique
  ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 20
`);
console.log(JSON.stringify(idx, (k,v)=>typeof v==='bigint'?v.toString():v, 1));

const total = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int n, pg_size_pretty(sum(pg_relation_size(s.indexrelid))::bigint) total_size
  FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
  WHERE s.idx_scan = 0 AND NOT i.indisprimary AND NOT i.indisunique
`);
console.log('total unused (non-PK, non-unique):', JSON.stringify(total));
await prisma.$disconnect();
