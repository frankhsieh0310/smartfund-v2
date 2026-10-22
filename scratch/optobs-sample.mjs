import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const sample = await prisma.$queryRawUnsafe(`SELECT * FROM option_observations LIMIT 5`);
console.log(JSON.stringify(sample, (k,v)=>typeof v==='bigint'?v.toString():v, 1));
await prisma.$disconnect();
