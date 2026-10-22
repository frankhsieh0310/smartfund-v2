import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const rows = await prisma.$queryRawUnsafe(`
  SELECT code, name, company, currency, latest_nav::text, latest_nav_date
  FROM funds
  WHERE company IN ('野村投信','元大投信','國泰投信') AND name ~ '月配'
    AND COALESCE(data_provider,'') NOT IN ('yahoo','SEC')
  ORDER BY company, code LIMIT 15
`);
console.log(JSON.stringify(rows, null, 1));
await prisma.$disconnect();
