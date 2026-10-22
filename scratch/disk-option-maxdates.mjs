import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 20000`);
const r = await prisma.$queryRawUnsafe(`SELECT max(observed_at) max_obs, max(trade_date) max_trade FROM option_observations`).catch(e=>({error:e.message}));
console.log('max observed_at/trade_date:', JSON.stringify(r));
await prisma.$disconnect();
