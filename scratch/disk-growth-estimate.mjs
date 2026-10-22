import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
const stocks = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM stocks WHERE is_active=true`);
const etfs = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM etfs WHERE is_active=true`);
const funds = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM funds WHERE is_active=true`);
console.log('active stocks:', JSON.stringify(stocks), 'etfs:', JSON.stringify(etfs), 'funds:', JSON.stringify(funds));

// bytes per row estimate (total_size / live_tup) for the 3 big active tables, from earlier query results
const bytesPerRow = {
  stock_history: 66549014528 / 106069097,
  stock_technical: 63416262656 / 107610414,
  fund_history: 38558179328 / 84249017,
};
console.log('bytes/row:', JSON.stringify(bytesPerRow));
await prisma.$disconnect();
