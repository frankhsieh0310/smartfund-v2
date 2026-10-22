import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const c = await prisma.$queryRawUnsafe(`SELECT company, count(*)::int n FROM funds WHERE company ~ '元大|國泰' GROUP BY company`);
console.log(JSON.stringify(c));
const rows = await prisma.$queryRawUnsafe(`
  SELECT code, name, company FROM funds
  WHERE company ~ '元大|國泰' AND name ~ '配息'
    AND COALESCE(data_provider,'') NOT IN ('yahoo','SEC')
  LIMIT 10
`);
console.log(JSON.stringify(rows, null, 1));
await prisma.$disconnect();
