import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function searchYahoo(q) {
  const query = encodeURIComponent(JSON.stringify({ onshore: "2", q, limit: 5 }));
  const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsSearch;query=${query}?intl=tw&lang=zh-Hant-TW&region=TW&site=finance&device=desktop`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    throw Object.assign(new Error(`RATE_LIMITED_${res.status}`), { rateLimited: true });
  }
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const sample = await prisma.$queryRawUnsafe(
  `SELECT code, isin, name, currency FROM funds WHERE data_provider='tdcc-offshore' ORDER BY random() LIMIT 20`
);

const results = [];
for (const f of sample) {
  // strip share-class suffix after full/half-width dash for a cleaner search term
  const baseName = f.name.split(/[－\-]/)[0].trim();
  try {
    const r = await searchYahoo(baseName);
    const found = (r.funds || []).length > 0;
    results.push({ dbName: f.name, searchTerm: baseName, found, topMatch: found ? r.funds[0].name : null, resultsTotal: r.pagination?.resultsTotal ?? r.funds?.length ?? 0 });
  } catch (e) {
    if (e.rateLimited) { console.log('RATE LIMITED, stopping:', e.message); break; }
    results.push({ dbName: f.name, searchTerm: baseName, found: false, error: e.message });
  }
  await sleep(1100);
}

const foundCount = results.filter(r => r.found).length;
console.log(`\n=== Yahoo fund-name search test: ${foundCount}/${results.length} found at least 1 candidate ===`);
for (const r of results) {
  console.log(`  DB: "${r.dbName}" | search:"${r.searchTerm}" | found=${r.found} (total=${r.resultsTotal}) | top:"${r.topMatch ?? r.error ?? ''}"`);
}

await prisma.$disconnect();
