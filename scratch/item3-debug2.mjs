import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const companies = await prisma.$queryRawUnsafe(`
  SELECT f.company, count(*)::int n FROM fund_distribution_observations fd JOIN funds f ON f.id = fd.fund_id
  GROUP BY f.company ORDER BY n DESC LIMIT 20
`);
console.log(JSON.stringify(companies));
await prisma.$disconnect();
