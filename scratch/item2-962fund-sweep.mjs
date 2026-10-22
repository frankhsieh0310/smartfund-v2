import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
const prisma = new PrismaClient();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchYahoo(q) {
  const query = encodeURIComponent(JSON.stringify({ onshore: "2", q, limit: 3 }));
  const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsSearch;query=${query}?intl=tw&lang=zh-Hant-TW&region=TW&site=finance&device=desktop`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw Object.assign(new Error(`RATE_LIMITED_${res.status}`), { rateLimited: true });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

function normKey(s) { return String(s).normalize('NFKC').replace(/[\s－\-()（）]/g, '').toLowerCase(); }

// class markers for primary (non-hedge) comparison, mirroring sitca-nav-sync's approach
function classMarkers(name) {
  const n = String(name ?? '');
  const out = [];
  for (const m of ['累積','配息','月配','季配','年配','不配息','A類','B類','N類','I類','S類']) if (n.includes(m)) out.push(m);
  return out;
}
function currencyMarkers(name) {
  const n = String(name ?? '');
  const out = [];
  for (const [label, re] of [['USD',/美元|美金/],['CNY',/人民幣/],['JPY',/日圓|日幣/],['AUD',/澳幣/],['EUR',/歐元/],['GBP',/英鎊/],['CAD',/加幣/],['ZAR',/南非幣/],['SGD',/新加坡幣/],['HKD',/港幣/],['NZD',/紐幣|紐西蘭幣/],['CHF',/瑞士法郎/]]) {
    if (re.test(n)) out.push(label);
  }
  return out;
}

const funds = await prisma.$queryRawUnsafe(
  `SELECT id, code, isin, name, currency, company FROM funds WHERE data_provider='tdcc-offshore' ORDER BY code`
);
console.log(`Total tdcc-offshore funds to process: ${funds.length}`);

const results = [];
let processed = 0;
const checkpointPath = 'scratch/item2-checkpoint.json';
let startIdx = 0;
if (fs.existsSync(checkpointPath)) {
  const cp = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  startIdx = cp.nextIdx;
  results.push(...cp.results);
  console.log(`Resuming from checkpoint at index ${startIdx}`);
}

for (let i = startIdx; i < funds.length; i++) {
  const f = funds[i];
  let rec = { dbCode: f.code, dbIsin: f.isin, dbName: f.name, dbCurrency: f.currency };
  try {
    const sr = await searchYahoo(f.name);
    const exact = (sr.funds || []).find(x => normKey(x.name) === normKey(f.name));
    const cand = exact || (sr.funds || [])[0];
    if (!cand) {
      rec.yahooFundId = null; rec.yahooName = null; rec.exactMatch = false;
      rec.currencyConsistent = null; rec.classConsistent = null;
    } else {
      rec.yahooFundId = cand.id;
      rec.yahooName = cand.name;
      rec.exactMatch = normKey(cand.name) === normKey(f.name);
      const dbCcy = currencyMarkers(f.name);
      const yahooCcy = currencyMarkers(cand.name);
      rec.currencyConsistent = dbCcy.length === 0 && yahooCcy.length === 0 ? null : JSON.stringify(dbCcy) === JSON.stringify(yahooCcy);
      const dbClass = classMarkers(f.name);
      const yahooClass = classMarkers(cand.name);
      rec.classConsistent = dbClass.length === 0 && yahooClass.length === 0 ? null : JSON.stringify(dbClass) === JSON.stringify(yahooClass);
    }
  } catch (e) {
    if (e.rateLimited) {
      console.log(`RATE LIMITED at index ${i} (code=${f.code}): ${e.message} -- STOPPING`);
      fs.writeFileSync(checkpointPath, JSON.stringify({ nextIdx: i, results }, null, 1));
      break;
    }
    rec.error = e.message;
  }
  results.push(rec);
  processed++;
  if (processed % 50 === 0) {
    console.log(`Progress: ${i+1}/${funds.length}`);
    fs.writeFileSync(checkpointPath, JSON.stringify({ nextIdx: i + 1, results }, null, 1));
  }
  await sleep(1100);
}

// final save
fs.writeFileSync(checkpointPath, JSON.stringify({ nextIdx: funds.length, results }, null, 1));

const csvHeader = 'db_code,db_isin,db_name,db_currency,yahoo_fund_id,yahoo_name,exact_match,currency_consistent,class_consistent,error';
const csvLines = results.map(r => [r.dbCode, r.dbIsin, r.dbName, r.dbCurrency, r.yahooFundId ?? '', r.yahooName ?? '', r.exactMatch ?? '', r.currencyConsistent ?? '', r.classConsistent ?? '', r.error ?? ''].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
fs.writeFileSync('scratch/item2-tdcc-offshore-yahoo-mapping.csv', [csvHeader, ...csvLines].join('\n'));

const found = results.filter(r => r.yahooFundId).length;
const exact = results.filter(r => r.exactMatch).length;
console.log(`\n=== Summary: ${results.length} processed, ${found} found candidate, ${exact} exact name match ===`);
await prisma.$disconnect();
