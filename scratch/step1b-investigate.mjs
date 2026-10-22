import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const dist = await prisma.$queryRawUnsafe(`
  SELECT data_provider, data_source IS NOT NULL AS has_data_source, count(*)::int n
  FROM funds WHERE is_active = true AND currency = 'TWD'
  GROUP BY data_provider, has_data_source ORDER BY n DESC
`);
console.log('Among is_active AND currency=TWD, data_provider breakdown:', JSON.stringify(dist));

const total = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM funds WHERE is_active=true AND currency='TWD'`);
console.log('Total currency=TWD AND is_active:', JSON.stringify(total));

// what does data_provider look like for ALL active funds (not just TWD)?
const allDist = await prisma.$queryRawUnsafe(`
  SELECT data_provider, count(*)::int n FROM funds WHERE is_active=true GROUP BY data_provider ORDER BY n DESC
`);
console.log('All active funds by data_provider:', JSON.stringify(allDist));
await prisma.$disconnect();
