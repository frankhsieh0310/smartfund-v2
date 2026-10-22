import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);
for (const [t, col] of [['stock_history','date'],['stock_technical','date'],['fund_history','date'],['etf_history','date'],['stock_financial_facts','period_end']]) {
  const r = await prisma.$queryRawUnsafe(`SELECT max(${col}) m FROM ${t}`).catch(e=>({error:e.message}));
  console.log(t, JSON.stringify(r));
}
await prisma.$disconnect();
