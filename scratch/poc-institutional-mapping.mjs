import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

// Normalize a company/issuer name for exact (never "contains") matching: uppercase, strip
// legal-entity suffixes and share-class/security-type noise, collapse whitespace/punctuation.
// This is the tier-4 "issuer-name normalized fallback" from the mapping priority order — it is
// only ever used as an equality check after normalization, never a substring/contains match.
function normalizeName(raw) {
  if (!raw) return '';
  let s = raw.toUpperCase();
  s = s.replace(/[.,]/g, ' ');
  s = s.replace(/\bCOMMON STOCK\b/g, ' ');
  s = s.replace(/\bORDINARY SHARES?\b/g, ' ');
  s = s.replace(/\bAMERICAN DEPOSITARY (SHARES?|RECEIPTS?)\b/g, ' ');
  s = s.replace(/\bADR\b|\bADS\b/g, ' ');
  s = s.replace(/\bCLASS\s+[A-Z]\b/g, ' ');
  s = s.replace(/\bNEW\b/g, ' ');
  s = s.replace(/\bREIT\b/g, ' ');
  // SEC 13F issuer names use the form's own approved abbreviation list (fixed-width field) —
  // HLDG(S)/GRP are the same legal-suffix words as HOLDING(S)/GROUP below, just abbreviated.
  s = s.replace(/\bHLDGS?\b/g, ' ');
  s = s.replace(/\bGRP\b/g, ' ');
  s = s.replace(/\bCOM\b/g, ' ');
  s = s.replace(/\b(INCORPORATED|INC|CORPORATION|CORP|COMPANY|CO|LIMITED|LTD|HOLDINGS?|GROUP|TRUST|PLC|LLC|LP|L P|NV|N V|SA|S A|AG|SE)\b/g, ' ');
  s = s.replace(/[^A-Z0-9 ]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

const q = async (sql, params = []) => (await client.query(sql, params)).rows;

// --- A. schema / presence audit ---
const [rowsTotal] = await q('select count(*) c from institutional_holdings');
const [managers] = await q('select count(distinct institution_id) c from institutional_holdings');
const [periods] = await q('select count(distinct report_date) c from institutional_holdings');
const [cusipPct] = await q("select round(100.0*count(*) filter (where cusip is not null and cusip<>'')/count(*),1) pct from institutional_holdings");
const [issuerPct] = await q("select round(100.0*count(*) filter (where issuer_name is not null and issuer_name<>'')/count(*),1) pct from institutional_holdings");
const [secIdPct] = await q("select round(100.0*count(*) filter (where security_id is not null)/count(*),1) pct from institutional_holdings");
console.log('=== A. AUDIT ===');
console.log({ rowsTotal: rowsTotal.c, managers: managers.c, periods: periods.c, cusipPct: cusipPct.pct, issuerPct: issuerPct.pct, secIdPctBefore: secIdPct.pct, tickerColumn: 'NOT PRESENT on institutional_holdings' });

// --- B/C. bounded PoC: latest report_date, top 3 managers by row count ---
const [latest] = await q("select to_char(max(report_date),'YYYY-MM-DD') mx from institutional_holdings");
const latestDate = latest.mx;
const top3 = await q(
  `select institution_id, count(*) c from institutional_holdings where report_date=$1::date group by 1 order by 2 desc limit 3`,
  [latestDate]
);
const top3Ids = top3.map((r) => r.institution_id);
const pocRows = await q(
  `select id, institution_id, issuer_name, cusip from institutional_holdings where report_date=$1::date and institution_id = any($2::text[])`,
  [latestDate, top3Ids]
);
console.log('\n=== C. BOUNDED POC (latest quarter', latestDate, ', top 3 managers by row count) ===');
console.log('managers:', top3);
console.log('poc row count:', pocRows.length);

// Preload lookup sets: securities by cusip, stocks by normalized company_name -> distinct ticker set
const secByCusip = new Map((await q("select id, cusip, name from securities where cusip is not null and cusip<>''")).map((r) => [r.cusip, r]));
const stockRows = await q("select id, ticker, company_name, exchange, country, is_active from stocks where company_name is not null");
// 13F is a US SEC filing regime — its issuers are overwhelmingly US-domiciled/US-listed, or trade
// in the US as an ADR (foreign country, US exchange). Narrowing to a US-country-or-US-exchange
// listing first breaks name collisions against foreign cross-listings of the same company on a
// different exchange/ticker. This is a data-quality disambiguation applied identically to every
// issuer name, never a per-ticker hardcode.
const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'NYSEARCA', 'ARCA', 'AMEX', 'BATS', 'IEX']);
const stocksByNormName = new Map();
const usStocksByNormName = new Map();
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

function resolve(issuerName, cusip) {
  // Tier 1: CUSIP exact match to an existing securities row.
  const sec = cusip ? secByCusip.get(cusip) : null;
  // Tier 4: issuer-name normalized exact match to stocks.company_name, only accepted when it
  // resolves to a SINGLE distinct ticker — first among US-domiciled listings (breaks foreign
  // cross-listing collisions), else among all listings. An unresolved collision never auto-picks.
  const normKey = normalizeName(issuerName);
  const usSet = usStocksByNormName.get(normKey);
  const allSet = stocksByNormName.get(normKey);
  const tickerSet = usSet && usSet.size >= 1 ? usSet : allSet;
  const ticker = tickerSet && tickerSet.size === 1 ? [...tickerSet][0] : null;
  return { securityId: sec?.id ?? null, ticker, ambiguous: Boolean(tickerSet && tickerSet.size > 1) };
}

let mapped = 0;
const unmapped = [];
for (const row of pocRows) {
  const r = resolve(row.issuer_name, row.cusip);
  if (r.securityId || r.ticker) mapped++;
  else unmapped.push({ issuer_name: row.issuer_name, cusip: row.cusip, ambiguous: r.ambiguous });
}
console.log('poc mapped (security_id OR ticker resolved):', mapped, '/', pocRows.length, `(${(100 * mapped / pocRows.length).toFixed(1)}%)`);
const unmappedByIssuer = new Map();
for (const u of unmapped) unmappedByIssuer.set(u.issuer_name, u);
console.log('top 20 unresolved issuer_name (distinct):');
console.log([...unmappedByIssuer.values()].slice(0, 20));

await client.end();
