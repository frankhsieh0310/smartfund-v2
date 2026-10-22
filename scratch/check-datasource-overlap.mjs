import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const sample = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int total, count(data_source)::int with_data_source, count(*) FILTER (WHERE data_provider='yahoo')::int yahoo_provider
  FROM funds WHERE last_nav_source = 'SITCA_FSC_OFFICIAL_DAILY_NAV_CSV' AND currency = 'TWD'
`);
console.log('Among last_nav_source=SITCA, currency=TWD funds:', JSON.stringify(sample));
await prisma.$disconnect();
