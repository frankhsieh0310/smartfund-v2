import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const u = await prisma.$queryRawUnsafe(`SELECT underlying, underlying_type, count(*)::int n FROM option_contracts GROUP BY underlying, underlying_type ORDER BY n DESC LIMIT 20`);
console.log(JSON.stringify(u));
await prisma.$disconnect();
