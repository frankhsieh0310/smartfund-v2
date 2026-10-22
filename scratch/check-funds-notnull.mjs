import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const cols = await prisma.$queryRawUnsafe(`
  SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name='funds' AND is_nullable='NO'
`);
console.log(JSON.stringify(cols, null, 1));
await prisma.$disconnect();
