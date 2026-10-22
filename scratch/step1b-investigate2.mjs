import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const edge = await prisma.$queryRawUnsafe(`
  SELECT id, code, name, currency, data_provider, data_source
  FROM funds WHERE is_active=true AND currency != 'TWD' AND data_provider IS DISTINCT FROM 'yahoo' AND data_provider IS DISTINCT FROM 'SEC'
`);
console.log(`Count: ${edge.length}`);
console.log(JSON.stringify(edge, null, 1));
await prisma.$disconnect();
