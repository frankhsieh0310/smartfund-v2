import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function searchYahoo(q) {
  const query = encodeURIComponent(JSON.stringify({ onshore: "2", q, limit: 5 }));
  const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsSearch;query=${query}?intl=tw&lang=zh-Hant-TW&region=TW&site=finance&device=desktop`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw Object.assign(new Error(`RATE_LIMITED_${res.status}`), { rateLimited: true });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normKey(s) { return String(s).normalize('NFKC').replace(/[\s－\-()（）]/g, '').toLowerCase(); }

const sample = await prisma.$queryRawUnsafe(
  `SELECT code, isin, name, currency FROM funds WHERE data_provider='tdcc-offshore' ORDER BY random() LIMIT 20`
);

const results = [];
for (const f of sample) {
  try {
    const r = await searchYahoo(f.name);
    const funds = r.funds || [];
    const exact = funds.find(x => normKey(x.name) === normKey(f.name));
    results.push({ dbName: f.name, found: funds.length > 0, exactMatch: !!exact, resultsTotal: r.pagination?.resultsTotal ?? funds.length, top3: funds.slice(0,3).map(x=>x.name) });
  } catch (e) {
    if (e.rateLimited) { console.log('RATE LIMITED, stopping:', e.message); break; }
    results.push({ dbName: f.name, found: false, exactMatch: false, error: e.message });
  }
  await sleep(1100);
}

const foundCount = results.filter(r => r.found).length;
const exactCount = results.filter(r => r.exactMatch).length;
console.log(`\n=== Full-name query test: found-any=${foundCount}/${results.length}, exact-name-match=${exactCount}/${results.length} ===`);
for (const r of results) {
  console.log(`  DB: "${r.dbName}"`);
  console.log(`    exactMatch=${r.exactMatch} total=${r.resultsTotal} top3=${JSON.stringify(r.top3 || r.error)}`);
}
await prisma.$disconnect();
