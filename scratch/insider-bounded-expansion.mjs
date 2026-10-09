// Bounded incremental expansion of insider Form 4 coverage — NOT a rewrite of the existing
// SEC ingestion. Root cause of "~10 issuers / 3 transactions": the only script that ever wrote to
// insider_ownership_transactions (scripts/data/insider-ownership/run-global-insider-ownership.ts)
// is a single-company canary hardcoded to AAPL, processing exactly one Form 4 filing's first
// transaction per run. insider_ownership_eligible_issuers (10 tickers, CIKs already resolved) was
// populated by a separate eligibility check that was never actually consumed by a real ingest loop.
//
// This script reuses the exact same parse/insert logic as the canary (same table, same columns,
// same source_key/ON CONFLICT idempotency, same SEC submissions-feed + filing-XML approach) and
// simply LOOPS over all 10 already-eligible issuers instead of one hardcoded ticker, and reads ALL
// recent Form 4/4A filings (bounded to the last 5 per issuer) and ALL of each filing's transactions
// (not just the first). No schema change. No full-EDGAR re-scrape — bounded to the existing
// SmartMatch-eligible universe.
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

const UA = 'SmartFund-GlobalInsiderOwnership/1.0 data-operations@smartfund.local';
const FILINGS_PER_ISSUER = 5;

const tag = (block, name) => block.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i'))?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '';
const xmlValue = (block, name) => block.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>[\\s\\S]*?<(?:\\w+:)?value(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?value>[\\s\\S]*?<\\/(?:\\w+:)?${name}>`, 'i'))?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '';
function parseForm4(xml) {
  const symbol = tag(xml, 'issuerTradingSymbol');
  const insider = tag(xml, 'rptOwnerName');
  const role = xmlValue(xml, 'officerTitle') || null;
  const blocks = xml.match(/<(?:\w+:)?nonDerivativeTransaction(?:\s[^>]*)?>[\s\S]*?<\/(?:\w+:)?nonDerivativeTransaction>/gi) ?? [];
  return {
    symbol, insider, role,
    transactions: blocks.map((block, index) => ({
      index, transactionDate: xmlValue(block, 'transactionDate'), transactionType: tag(block, 'transactionCode'),
      shares: Number(xmlValue(block, 'transactionShares')),
      price: xmlValue(block, 'transactionPricePerShare') ? Number(xmlValue(block, 'transactionPricePerShare')) : null,
      ownershipAfter: xmlValue(block, 'sharesOwnedFollowingTransaction') ? Number(xmlValue(block, 'sharesOwnedFollowingTransaction')) : null,
    })).filter((t) => t.transactionDate && t.transactionType && Number.isFinite(t.shares)),
  };
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}
async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/xml,text/xml,*/*' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

const issuers = await q(`select security_id, cik, ticker from insider_ownership_eligible_issuers where eligibility_status='SOURCE_READY' order by deterministic_rank`);
console.log('eligible issuers:', issuers.length);

let totalFilingsSeen = 0, totalTransactionsWritten = 0, totalTransactionsSeen = 0;
const perIssuer = [];
for (const issuer of issuers) {
  const cik = String(Number(issuer.cik)).padStart(10, '0');
  let filingsChecked = 0, txWritten = 0, txSeen = 0;
  try {
    const submissions = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const recent = submissions?.filings?.recent ?? {};
    const forms = recent.form ?? [];
    const form4Indexes = forms.map((f, i) => ({ f, i })).filter(({ f }) => f === '4' || f === '4/A').slice(0, FILINGS_PER_ISSUER);
    for (const { i } of form4Indexes) {
      filingsChecked++;
      const accession = recent.accessionNumber[i];
      const accessionPath = accession.replaceAll('-', '');
      const primaryDocument = String(recent.primaryDocument[i]).split('/').at(-1);
      const filingUrl = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionPath}/${primaryDocument}`;
      const xml = await fetchText(filingUrl);
      const parsed = parseForm4(xml);
      for (const transaction of parsed.transactions) {
        txSeen++;
        const sourceKey = createHash('sha256').update(`${accession}|${transaction.index}|${transaction.transactionDate}|${transaction.transactionType}`).digest('hex');
        const existing = await q(`select 1 from insider_ownership_transactions where source_key=$1`, [sourceKey]);
        await client.query(
          `insert into insider_ownership_transactions (id,security_id,insider,role,transaction_date,transaction_type,shares,price,ownership_after,source,filing_id,source_key,created_at,updated_at)
           values ($1::uuid,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,now(),now())
           on conflict (source_key) do update set shares=excluded.shares, price=excluded.price, ownership_after=excluded.ownership_after, updated_at=now()`,
          [randomUUID(), issuer.security_id, parsed.insider, parsed.role, transaction.transactionDate, transaction.transactionType, transaction.shares, transaction.price, transaction.ownershipAfter, 'SEC EDGAR Form 4', accession, sourceKey]
        );
        if (!existing.length) txWritten++;
      }
      await new Promise((r) => setTimeout(r, 150)); // polite pacing against SEC EDGAR
    }
    perIssuer.push({ ticker: issuer.ticker, ok: true, filingsChecked, transactionsSeen: txSeen, transactionsWritten: txWritten });
  } catch (e) {
    perIssuer.push({ ticker: issuer.ticker, ok: false, error: String(e.message || e) });
  }
  totalFilingsSeen += filingsChecked; totalTransactionsWritten += txWritten; totalTransactionsSeen += txSeen;
}

console.log(JSON.stringify({ issuers: issuers.length, totalFilingsSeen, totalTransactionsSeen, totalTransactionsWritten, perIssuer }, null, 2));
await client.end();
