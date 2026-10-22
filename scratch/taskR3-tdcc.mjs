import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const rows = await prisma.$queryRawUnsafe(`SELECT code, isin, name, currency FROM funds WHERE data_provider='tdcc-offshore' LIMIT 10`);
console.log(JSON.stringify(rows, null, 1));
const isinCount = await prisma.$queryRawUnsafe(`SELECT count(*)::int n, count(isin)::int withIsin FROM funds WHERE data_provider='tdcc-offshore'`);
console.log('isin coverage:', JSON.stringify(isinCount));
const codeFormats = await prisma.$queryRawUnsafe(`SELECT code FROM funds WHERE data_provider='tdcc-offshore' AND code IS NOT NULL LIMIT 15`);
console.log('code samples:', JSON.stringify(codeFormats));
await prisma.$disconnect();
