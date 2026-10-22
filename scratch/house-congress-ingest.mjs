// P0-2D — bounded production PoC: US House Periodic Transaction Reports (PTRs), last 30 days.
// Official source only, no login wall:
//   Index:    https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.ZIP
//   Document: https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{year}/{DocID}.pdf
// Writes to political_persons / political_transactions (additive tables, see
// scratch/create-congress-tables.sql). Dedup key = UNIQUE(person_id, source_document_id, asset_name,
// transaction_date, transaction_type, amount_min, amount_max) — an amended filing that repeats an
// unchanged line item is a no-op via ON CONFLICT DO NOTHING, never a duplicate row.
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

const YEAR = 2026;
const LOOKBACK_DAYS = 30;
const UA = 'Mozilla/5.0 SmartFund-Congress-PoC/1.0';

function normalizeName(raw) {
  if (!raw) return '';
  let s = raw.toUpperCase();
  s = s.replace(/[.,]/g, ' ');
  s = s.replace(/\bCOMMON STOCK\b/g, ' ');
  s = s.replace(/\bNEW\b/g, ' ');
  s = s.replace(/\b(INCORPORATED|INC|CORPORATION|CORP|COMPANY|CO|LIMITED|LTD|HOLDINGS?|GROUP|TRUST|PLC|LLC|LP|NV|SA|AG|SE)\b/g, ' ');
  s = s.replace(/[^A-Z0-9 ]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// --- fetch + unzip the official yearly index ---
const zipRes = await fetch(`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${YEAR}FD.ZIP`, { headers: { 'user-agent': UA } });
if (!zipRes.ok) throw new Error(`index fetch failed: HTTP ${zipRes.status}`);
const dir = mkdtempSync(path.join(tmpdir(), 'house-fd-'));
const zipPath = path.join(dir, 'fd.zip');
writeFileSync(zipPath, Buffer.from(await zipRes.arrayBuffer()));
execFileSync('unzip', ['-o', zipPath, '-d', dir]);
const xml = execFileSync('cat', [path.join(dir, `${YEAR}FD.xml`)]).toString('utf8');

const tag = (block, name) => block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? '';
const members = [...xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)].map((m) => m[1]);
const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 3600_000;
const ptrs = members
  .map((m) => ({ last: tag(m, 'Last'), first: tag(m, 'First'), state: tag(m, 'StateDst'), filingType: tag(m, 'FilingType'), filingDate: tag(m, 'FilingDate'), docId: tag(m, 'DocID') }))
  .filter((m) => m.filingType === 'P' && Date.parse(m.filingDate) >= cutoff);

console.log(`House PTR filings in last ${LOOKBACK_DAYS} days:`, ptrs.length);

// --- canonical ticker universe (ticker-exact only; normalized-name fallback below) ---
const stockRows = await q(`select id, ticker, company_name from stocks where country='US' and is_active`);
const usByTicker = new Map();
for (const s of stockRows) if (!usByTicker.has(s.ticker)) usByTicker.set(s.ticker, s);
const usByNormName = new Map();
for (const s of stockRows) { const k = normalizeName(s.company_name); if (k && !usByNormName.has(k)) usByNormName.set(k, s); }

let filingsFetched = 0, transactionsParsed = 0, transactionsWritten = 0, duplicatesSkipped = 0;
let mappedCount = 0, unmappedCount = 0;
const unmappedSample = new Set();
const peopleSeen = new Set();

for (const filing of ptrs) {
  let pdfBuf;
  try {
    const pdfRes = await fetch(`https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${YEAR}/${filing.docId}.pdf`, { headers: { 'user-agent': UA } });
    if (!pdfRes.ok) continue;
    pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  } catch { continue; }
  filingsFetched++;
  const pdfPath = path.join(dir, `${filing.docId}.pdf`);
  writeFileSync(pdfPath, pdfBuf);
  let text;
  try { text = execFileSync('pdftotext', ['-layout', pdfPath, '-']).toString('utf8'); } catch { continue; }

  const personSourceId = `${filing.last},${filing.first},${filing.state}`;
  const personName = `${filing.first} ${filing.last}`.trim();
  const personRow = (await q(
    `insert into political_persons (name, chamber, state, party, source_person_id)
     values ($1,'HOUSE',$2,null,$3)
     on conflict (chamber, source_person_id) do update set name=excluded.name, updated_at=now()
     returning id`,
    [personName, filing.state, personSourceId]
  ))[0];
  peopleSeen.add(personRow.id);

  // Line shape (see PoC): "<Asset name> (<TICKER>) [ST]  <TxnType> <date> <date> <amount range>"
  // followed by an "O :" owner line further down in the same block.
  const blockRe = /([A-Za-z0-9&.,'\- ]+?)\s*\(([A-Z]{1,6})\)\s*\[ST\]\s*\n?\s*([PSE]\s?\(?\w*\)?)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\$[\d,]+|\$[\d,]+\s*-\s*\$[\d,]+|\$[\d,]+\+)([\s\S]{0,300}?)(?=[A-Za-z0-9&.,'\- ]+?\s*\([A-Z]{1,6}\)\s*\[ST\]|$)/g;
  let m;
  while ((m = blockRe.exec(text))) {
    transactionsParsed++;
    const [, assetNameRaw, ticker, txnTypeRaw, txnDateStr, discDateStr, amountStr, tail] = m;
    const assetName = assetNameRaw.trim();
    const txnType = txnTypeRaw.trim().charAt(0);
    const ownerMatch = tail.match(/O\s*:\s*([A-Za-z ]+?)(?:\n|$)/);
    const owner = ownerMatch ? ownerMatch[1].trim() : null;
    const [txMonth, txDay, txYear] = txnDateStr.split('/');
    const [dMonth, dDay, dYear] = discDateStr.split('/');
    const amounts = amountStr.match(/\$[\d,]+/g)?.map((a) => Number(a.replace(/[$,]/g, ''))) ?? [];
    const amountMin = amounts[0] ?? null;
    const amountMax = amounts[1] ?? amounts[0] ?? null;

    let stockId = null, mappingMethod = 'UNMAPPED';
    const tickerHit = usByTicker.get(ticker);
    if (tickerHit) { stockId = tickerHit.id; mappingMethod = 'TICKER_EXACT'; }
    else {
      const nameHit = usByNormName.get(normalizeName(assetName));
      if (nameHit) { stockId = nameHit.id; mappingMethod = 'NORMALIZED_NAME'; }
    }
    if (mappingMethod === 'UNMAPPED') { unmappedCount++; unmappedSample.add(`${assetName} (${ticker})`); } else mappedCount++;

    const ins = await client.query(
      `insert into political_transactions
        (person_id, stock_id, asset_name, ticker, transaction_type, transaction_date, disclosure_date,
         amount_min, amount_max, owner, source_url, source_document_id, filing_year, mapping_method)
       values ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12,$13,$14)
       on conflict (person_id, source_document_id, asset_name, transaction_date, transaction_type, amount_min, amount_max)
       do nothing`,
      [personRow.id, stockId, assetName, ticker, txnType, `${txYear}-${txMonth}-${txDay}`, `${dYear}-${dMonth}-${dDay}`,
       amountMin, amountMax, owner, `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${YEAR}/${filing.docId}.pdf`, filing.docId, YEAR, mappingMethod]
    );
    if (ins.rowCount > 0) transactionsWritten++; else duplicatesSkipped++;
  }
}

console.log(JSON.stringify({
  HOUSE_FILINGS_FETCHED: filingsFetched,
  HOUSE_TRANSACTIONS_PARSED: transactionsParsed,
  HOUSE_TRANSACTIONS_WRITTEN: transactionsWritten,
  HOUSE_DUPLICATES_SKIPPED: duplicatesSkipped,
  HOUSE_PEOPLE: peopleSeen.size,
  HOUSE_MAPPED: mappedCount,
  HOUSE_UNMAPPED: unmappedCount,
  HOUSE_MAPPING_PCT: mappedCount + unmappedCount > 0 ? `${(100 * mappedCount / (mappedCount + unmappedCount)).toFixed(1)}%` : 'n/a',
  unmapped_sample: [...unmappedSample].slice(0, 15),
}, null, 2));

await client.end();
