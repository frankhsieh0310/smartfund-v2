import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const foreignMarkers = /美元|美金|人民幣|日圓|日幣|澳幣|南非幣|港幣|英鎊|加幣|紐幣|瑞士法郎|新加坡幣|歐元/;
const rows = await prisma.$queryRawUnsafe(`
  SELECT code, name, currency, exchange, is_active FROM etfs
  WHERE name ~ '美元|人民幣|日圓|日幣|澳幣|南非幣|港幣|英鎊|加幣|紐幣|瑞士法郎|新加坡幣|歐元' AND currency = 'TWD'
`);
console.log(`Count: ${rows.length}`);
console.log(JSON.stringify(rows, null, 1));
await prisma.$disconnect();
