import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
const prisma = new PrismaClient();
const edge = await prisma.$queryRawUnsafe(`
  SELECT id, code, name, currency, data_provider
  FROM funds WHERE is_active=true AND currency != 'TWD' AND COALESCE(data_provider,'') NOT IN ('yahoo','SEC')
  ORDER BY currency, name
`);
console.log(`Total: ${edge.length}`);
const twdVariant = edge.filter(f => f.currency === '新台幣' || f.currency === '新臺幣');
const genuinelyForeign = edge.filter(f => f.currency !== '新台幣' && f.currency !== '新臺幣');
console.log(`\n=== ${twdVariant.length} 筆中文「新台幣／新臺幣」字串變體 (會統一改成 TWD) ===`);
for (const f of twdVariant) console.log(`  ${f.code} | ${f.name} | currency=${f.currency}`);
console.log(`\n=== ${genuinelyForeign.length} 筆真正外幣境內基金 (currency保持不變) ===`);
for (const f of genuinelyForeign) console.log(`  ${f.code} | ${f.name} | currency=${f.currency} | provider=${f.data_provider}`);
fs.writeFileSync('scratch/step1-43list.json', JSON.stringify(edge, null, 1));
await prisma.$disconnect();
