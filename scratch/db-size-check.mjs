import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const size = await prisma.$queryRawUnsafe(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);
console.log('DB size:', JSON.stringify(size));
await prisma.$disconnect();
