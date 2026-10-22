import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const r = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int n FROM fund_distribution_observations fd
  JOIN funds f ON f.id = fd.fund_id
  WHERE COALESCE(f.data_provider,'') NOT IN ('yahoo','SEC')
`);
console.log('domestic-fund distribution rows:', JSON.stringify(r));
await prisma.$disconnect();
