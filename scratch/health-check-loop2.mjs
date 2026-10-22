import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const mcs = await prisma.$queryRawUnsafe(`SELECT status, error, to_char(started_at,'HH24:MI') started FROM production_scheduler_runs WHERE job_id='MARKET_CLOSE_SYNC_SHADOW' ORDER BY started_at DESC LIMIT 1`);
const etf = await prisma.$queryRawUnsafe(`SELECT status, error, details->>'write_error_count' we FROM production_scheduler_runs WHERE job_id='ETF_RETURNS_SYNC' ORDER BY started_at DESC LIMIT 1`);
console.log('MCS:', JSON.stringify(mcs), '| ETF:', JSON.stringify(etf));
await prisma.$disconnect();
