import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const url = `https://smartfund-v2.vercel.app/api/mobile/current-market-data?scope=all&asset=FUND`;
const res = await fetch(url);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const json = await res.json();
const rows = json.data?.funds ?? [];
console.log(`Live API returned ${rows.length} funds in a single response (no pagination on this branch)`);

const liveIds = new Set(rows.map(r => r.fundId));

const dbNew = await prisma.$queryRawUnsafe(`SELECT id FROM funds WHERE is_active=true AND COALESCE(data_provider,'') NOT IN ('yahoo','SEC')`);
const dbNewIds = new Set(dbNew.map(r => r.id));
console.log(`DB new-condition set: ${dbNewIds.size}`);

const missingFromLive = [...dbNewIds].filter(id => !liveIds.has(id));
const extraInLive = [...liveIds].filter(id => !dbNewIds.has(id));
console.log(`DB\Live (missing from live API): ${missingFromLive.length}`);
console.log(`Live\DB (unexpected extra): ${extraInLive.length}`);

const oldSet = await prisma.$queryRawUnsafe(`SELECT id FROM funds WHERE is_active=true AND currency='TWD'`);
const oldIds = new Set(oldSet.map(r => r.id));
const oldMissingFromLive = [...oldIds].filter(id => !liveIds.has(id));
console.log(`\nOld TWD-set funds missing from live API (should be 0): ${oldMissingFromLive.length}`);
console.log(`live=${liveIds.size}, old=${oldIds.size}, diff=${liveIds.size - oldIds.size} (should be 43)`);

await prisma.$disconnect();
