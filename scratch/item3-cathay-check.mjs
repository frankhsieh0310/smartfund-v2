import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const rows = await prisma.$queryRawUnsafe(`
  SELECT code, name FROM funds WHERE company = '國泰投信' AND name ~ '配息'
    AND COALESCE(data_provider,'') NOT IN ('yahoo','SEC') LIMIT 10
`);
console.log(JSON.stringify(rows, null, 1));
await prisma.$disconnect();
