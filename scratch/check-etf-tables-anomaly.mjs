import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.$executeRawUnsafe(`SET statement_timeout = 15000`);

// Check for any obviously test-looking markers or anomalies in etf tables
// 1. etf_performances: any rows with suspicious created_at clustering outside normal cron cadence
const epCols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='etf_performances'`);
console.log('etf_performances columns:', epCols.map(c=>c.column_name).join(', '));

const etfCols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='etfs'`);
console.log('etfs columns:', etfCols.map(c=>c.column_name).join(', '));

const ehCols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='etf_history'`).catch(e => []);
console.log('etf_history columns:', ehCols.map(c=>c.column_name).join(', '));

const fhCols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='fund_history'`);
console.log('fund_history columns:', fhCols.map(c=>c.column_name).join(', '));
await prisma.$disconnect();
