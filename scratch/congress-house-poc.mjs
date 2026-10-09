// Bounded PoC — US House Periodic Transaction Reports (PTRs), official source, no login wall:
//   Index:    https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.ZIP  (real, verified)
//   Document: https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{year}/{DocID}.pdf   (real, verified)
// Read-only research PoC: parses a bounded recent slice, writes nothing to the database (no
// political_persons / political_transactions tables exist yet — this is PART 2.D verification
// that the source is real and parseable, not a production ingestion).
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const YEAR = 2026;
const MAX_FILINGS = 20; // bounded PoC, not a full-year pull

const zipUrl = `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${YEAR}FD.ZIP`;
const zipRes = await fetch(zipUrl, { headers: { 'user-agent': 'Mozilla/5.0' } });
if (!zipRes.ok) throw new Error(`index fetch failed: HTTP ${zipRes.status}`);
const zipBuf = Buffer.from(await zipRes.arrayBuffer());
const dir = mkdtempSync(path.join(tmpdir(), 'house-fd-'));
const zipPath = path.join(dir, 'fd.zip');
writeFileSync(zipPath, zipBuf);
execFileSync('unzip', ['-o', zipPath, '-d', dir]);
const xml = execFileSync('cat', [path.join(dir, `${YEAR}FD.xml`)]).toString('utf8');

const members = [...xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)].map((m) => m[1]);
const tag = (block, name) => block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? '';
const ptrs = members
  .map((m) => ({ last: tag(m, 'Last'), first: tag(m, 'First'), state: tag(m, 'StateDst'), filingType: tag(m, 'FilingType'), filingDate: tag(m, 'FilingDate'), docId: tag(m, 'DocID') }))
  .filter((m) => m.filingType === 'P')
  .sort((a, b) => new Date(b.filingDate).getTime() - new Date(a.filingDate).getTime())
  .slice(0, MAX_FILINGS);

console.log('PTR filings in 2026 index:', members.filter((m) => tag(m, 'FilingType') === 'P').length, '| PoC bounded to most recent', ptrs.length);

// Real US-listed tickers already known to smartfund-v2's canonical `stocks` universe (loaded once,
// used only for a ticker-exact membership check — never a "contains name" match, per Part C).
const pg = await import('pg');
const client = new pg.default.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const knownTickers = new Set((await client.query(`select distinct ticker from stocks where country='US'`)).rows.map((r) => r.ticker));

let parsed = 0, transactionsFound = 0, tickersMapped = 0, tickersUnmapped = 0;
const unmappedSample = new Set();
for (const filing of ptrs) {
  try {
    const pdfRes = await fetch(`https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${YEAR}/${filing.docId}.pdf`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!pdfRes.ok) { filing.error = `HTTP ${pdfRes.status}`; continue; }
    const pdfPath = path.join(dir, `${filing.docId}.pdf`);
    writeFileSync(pdfPath, Buffer.from(await pdfRes.arrayBuffer()));
    const text = execFileSync('pdftotext', ['-layout', pdfPath, '-']).toString('utf8');
    parsed++;
    // Line shape: "<Asset name> (<TICKER>) [ST]      <TxnType> <date> <date> <amount range>"
    const txnRe = /\(([A-Z]{1,6})\)\s*\[ST\]\s*\n?\s*([PSE]\s?\(?\w*\)?)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\$[\d,]+\s*-\s*\$[\d,]+|\$[\d,]+\+?)/g;
    let m; let filingTx = 0;
    while ((m = txnRe.exec(text))) {
      filingTx++; transactionsFound++;
      const ticker = m[1];
      if (knownTickers.has(ticker)) tickersMapped++; else { tickersUnmapped++; unmappedSample.add(ticker); }
    }
    filing.transactions = filingTx;
  } catch (e) {
    filing.error = String(e.message || e);
  }
}

console.log(JSON.stringify({
  filings_attempted: ptrs.length, filings_parsed: parsed,
  transactions_found: transactionsFound, tickers_mapped: tickersMapped, tickers_unmapped: tickersUnmapped,
  unmapped_sample: [...unmappedSample].slice(0, 15),
  sample_filings: ptrs.slice(0, 5),
}, null, 2));
await client.end();
