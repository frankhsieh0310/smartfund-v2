import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 8000`);
const sizes = await prisma.$queryRawUnsafe(`
  SELECT relname, n_live_tup::bigint AS approx_rows
  FROM pg_stat_user_tables WHERE relname IN ('etf_history','etf_performances','etfs','fund_history','funds')
  ORDER BY n_live_tup DESC
`);
console.log(JSON.stringify(sizes, (k,v)=>typeof v==='bigint'?v.toString():v));
await prisma.$disconnect();
