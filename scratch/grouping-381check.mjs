import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const master = await prisma.$queryRawUnsafe(`SELECT id, canonical_name, provider_master_key FROM fund_master WHERE id = '34566cf2-82d3-4dcc-bdc7-8c5b59e243a0'`);
console.log('Master:', JSON.stringify(master));
const sample = await prisma.$queryRawUnsafe(`
  SELECT f.name FROM fund_share_classes sc JOIN funds f ON f.id = sc.fund_id WHERE sc.master_fund_id = '34566cf2-82d3-4dcc-bdc7-8c5b59e243a0' LIMIT 10
`);
console.log('Sample members:', JSON.stringify(sample, null, 1));
await prisma.$disconnect();
