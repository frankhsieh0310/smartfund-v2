import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const ds = await prisma.$queryRawUnsafe(`SELECT data_source, data_provider, count(*)::int n FROM funds GROUP BY data_source, data_provider ORDER BY n DESC LIMIT 20`);
console.log(JSON.stringify(ds, null, 1));
const curr = await prisma.$queryRawUnsafe(`SELECT currency, count(*)::int n FROM funds GROUP BY currency ORDER BY n DESC`);
console.log('currency dist:', JSON.stringify(curr));
await prisma.$disconnect();
