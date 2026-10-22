import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 20000`);

const r = await prisma.$queryRawUnsafe(`
  SELECT to_char(observed_at,'YYYY-MM-DD') d, count(*)::int n
  FROM option_observations WHERE observed_at > now() - interval '7 days'
  GROUP BY d ORDER BY d
`).catch(e => ({error: e.message}));
console.log('option_observations by observed_at (7d):', JSON.stringify(r));
await prisma.$disconnect();
