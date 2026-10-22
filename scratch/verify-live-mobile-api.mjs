import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function fetchAllPages() {
  const ids = [];
  let page = 0;
  while (true) {
    const url = `https://smartfund-v2.vercel.app/api/mobile/current-market-data?scope=all&asset=FUND&limit=200&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rows = json.data?.funds ?? [];
    if (rows.length === 0) break;
    for (const r of rows) ids.push(r.fundId);
    page++;
    if (page > 50) throw new Error('too many pages, aborting');
  }
  return ids;
}

const liveIds = new Set(await fetchAllPages());
console.log(`Live API returned ${liveIds.size} funds`);

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
console.log(`Live API has exactly old+43? old=${oldIds.size}, live=${liveIds.size}, diff=${liveIds.size - oldIds.size}`);

await prisma.$disconnect();
