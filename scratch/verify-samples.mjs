import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

function normalizeName(raw) {
  if (!raw) return '';
  let s = raw.toUpperCase();
  s = s.replace(/[.,]/g, ' ');
  s = s.replace(/\bCOMMON STOCK\b/g, ' ');
  s = s.replace(/\bORDINARY SHARES?\b/g, ' ');
  s = s.replace(/\bAMERICAN DEPOSITARY (SHARES?|RECEIPTS?)\b/g, ' ');
  s = s.replace(/\bSPONSORED ADS\b/g, ' ');
  s = s.replace(/\bADR\b|\bADS\b/g, ' ');
  s = s.replace(/\bCLASS\s+[A-Z]\b/g, ' ');
  s = s.replace(/\bNEW\b/g, ' ');
  s = s.replace(/\bREIT\b/g, ' ');
  s = s.replace(/\bHLDGS?\b/g, ' ');
  s = s.replace(/\bGRP\b/g, ' ');
  s = s.replace(/\bCOM\b/g, ' ');
  s = s.replace(/\b(INCORPORATED|INC|CORPORATION|CORP|COMPANY|CO|LIMITED|LTD|HOLDINGS?|GROUP|TRUST|PLC|LLC|LP|L P|NV|N V|SA|S A|AG|SE)\b/g, ' ');
  s = s.replace(/\bMANUFAC\b/g, 'MANUFACTURING');
  s = s.replace(/\bMFG\b/g, 'MANUFACTURING');
  s = s.replace(/[^A-Z0-9 ]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'NYSEARCA', 'ARCA', 'AMEX', 'BATS', 'IEX']);
const stockRows = await q("select id, ticker, company_name, exchange, country from stocks where company_name is not null");
const usStocksByNormName = new Map();
const stocksByNormName = new Map();
for (const s of stockRows) {
  const key = normalizeName(s.company_name);
  if (!key) continue;
  if (!stocksByNormName.has(key)) stocksByNormName.set(key, new Set());
  stocksByNormName.get(key).add(s.ticker);
  if (s.country === 'US' || US_EXCHANGES.has(s.exchange)) {
    if (!usStocksByNormName.has(key)) usStocksByNormName.set(key, new Set());
    usStocksByNormName.get(key).add(s.ticker);
  }
}
function resolveTicker(issuerName) {
  const key = normalizeName(issuerName);
  const usSet = usStocksByNormName.get(key);
  const allSet = stocksByNormName.get(key);
  const set = usSet && usSet.size >= 1 ? usSet : allSet;
  return set && set.size === 1 ? [...set][0] : set ? `AMBIGUOUS(${[...set].join(',')})` : null;
}

const samples = await q("select distinct issuer_name from institutional_holdings where issuer_name ilike '%NVIDIA%' or issuer_name ilike '%APPLE%' or issuer_name ilike '%MICROSOFT%' or issuer_name ilike '%TAIWAN SEMI%' or issuer_name ilike '%ASML%'");
for (const s of samples) console.log(s.issuer_name.padEnd(55), '->', resolveTicker(s.issuer_name), '| normalized:', normalizeName(s.issuer_name));

await client.end();
