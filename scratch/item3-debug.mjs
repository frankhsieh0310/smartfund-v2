import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const companies = await prisma.$queryRawUnsafe(`SELECT DISTINCT company FROM funds WHERE company ~ '野村|元大|國泰' LIMIT 10`);
console.log(JSON.stringify(companies));
const distCount = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int n FROM fund_distribution_observations fd JOIN funds f ON f.id = fd.fund_id WHERE f.company ~ '野村'
`);
console.log('野村 dist rows:', JSON.stringify(distCount));
await prisma.$disconnect();
