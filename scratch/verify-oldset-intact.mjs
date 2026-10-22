import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const res = await fetch('https://smartfund-v2.vercel.app/api/mobile/current-market-data?scope=all&asset=FUND');
const json = await res.json();
const liveIds = new Set((json.data?.funds ?? []).map(r => r.fundId));
const dbOldSet = await prisma.$queryRawUnsafe(`SELECT id FROM funds WHERE is_active=true AND COALESCE(data_provider,'') NOT IN ('yahoo','SEC') AND data_provider IS DISTINCT FROM 'SITCA'`);
const missing = dbOldSet.filter(r => !liveIds.has(r.id));
console.log(`Old (pre-insert) set size: ${dbOldSet.length}, missing from live API: ${missing.length}`);
await prisma.$disconnect();
