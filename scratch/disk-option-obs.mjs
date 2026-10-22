import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 20000`);
const cols = await prisma.$queryRawUnsafe(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='option_observations' ORDER BY ordinal_position`);
console.log('columns:', JSON.stringify(cols));
await prisma.$disconnect();
