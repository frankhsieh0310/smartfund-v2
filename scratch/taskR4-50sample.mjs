import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
const prisma = new PrismaClient();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchYahoo(q, onshore) {
  const query = encodeURIComponent(JSON.stringify({ onshore, q, limit: 3 }));
  const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsSearch;query=${query}?intl=tw&lang=zh-Hant-TW&region=TW&site=finance&device=desktop`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw Object.assign(new Error(`RATE_LIMITED_${res.status}`), { rateLimited: true });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

async function fetchHoldingsPage(fundId) {
  const url = `https://tw.stock.yahoo.com/fund/holdings/${fundId}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw Object.assign(new Error(`RATE_LIMITED_${res.status}`), { rateLimited: true });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.text();
}

function normKey(s) { return String(s).normalize('NFKC').replace(/[\s－\-()（）]/g, '').toLowerCase(); }

function extractHoldings(html) {
  const m = html.match(/"holdings":\{"assetAlloc":\{"assetlastUpdated":"([^"]*)"[^}]*\},"portfolioHolding":\{"portfolioUpdated":"([^"]*)","portfolios":(\[[^\]]*\])/);
  if (!m) return null;
  let portfolios = [];
  try { portfolios = JSON.parse(m[3]); } catch {}
  return { assetLastUpdated: m[1], portfolioUpdated: m[2], top5: portfolios.slice(0, 5).map(p => ({ name: p.securityName, pct: p.astPct })) };
}

async function sampleAndCheck(whereClause, onshore, n, label) {
  const funds = await prisma.$queryRawUnsafe(
    `SELECT code, isin, name, currency, company FROM funds WHERE ${whereClause} ORDER BY random() LIMIT ${n}`
  );
  const rows = [];
  for (const f of funds) {
    let rec = { category: label, dbName: f.name, company: f.company, currency: f.currency };
    try {
      const sr = await searchYahoo(f.name, onshore);
      await sleep(1100);
      const cand = (sr.funds || [])[0];
      if (!cand) { rec.yahooFundId = null; rec.holdingsFound = false; rows.push(rec); continue; }
      rec.yahooFundId = cand.id;
      rec.yahooMatchName = cand.name;
      rec.exactNameMatch = normKey(cand.name) === normKey(f.name);
      const html = await fetchHoldingsPage(cand.id);
      await sleep(1100);
      const h = extractHoldings(html);
      if (h) {
        rec.holdingsFound = h.top5.length > 0;
        rec.portfolioUpdated = h.portfolioUpdated;
        rec.assetLastUpdated = h.assetLastUpdated;
        rec.top1 = h.top5[0]?.name ?? null;
      } else {
        rec.holdingsFound = false;
      }
    } catch (e) {
      if (e.rateLimited) { rec.error = e.message; rows.push(rec); console.log('RATE LIMITED, stopping category:', label, e.message); break; }
      rec.error = e.message;
    }
    rows.push(rec);
  }
  return rows;
}

const twRows = await sampleAndCheck(`currency = 'TWD' AND data_provider IS DISTINCT FROM 'tdcc-offshore'`, "1", 25, "DOMESTIC");
console.log(`Domestic sample done: ${twRows.length}`);
const offRows = await sampleAndCheck(`data_provider = 'tdcc-offshore'`, "2", 25, "OFFSHORE");
console.log(`Offshore sample done: ${offRows.length}`);

const all = [...twRows, ...offRows];
const csvHeader = 'category,db_name,company,currency,yahoo_fund_id,yahoo_match_name,exact_name_match,holdings_found,portfolio_updated,asset_last_updated,top1_holding,error';
const csvLines = all.map(r => [r.category, r.dbName, r.company, r.currency, r.yahooFundId ?? '', r.yahooMatchName ?? '', r.exactNameMatch ?? '', r.holdingsFound ?? '', r.portfolioUpdated ?? '', r.assetLastUpdated ?? '', r.top1 ?? '', r.error ?? ''].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
fs.writeFileSync('scratch/taskR4-50fund-results.csv', [csvHeader, ...csvLines].join('\n'));

const foundRate = all.filter(r => r.holdingsFound).length;
console.log(`\n=== Summary: ${foundRate}/${all.length} have holdings data ===`);
console.log(`Domestic: ${twRows.filter(r=>r.holdingsFound).length}/${twRows.length}, Offshore: ${offRows.filter(r=>r.holdingsFound).length}/${offRows.length}`);
await prisma.$disconnect();
