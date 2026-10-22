import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

function normalizeIssuerName(raw) {
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

async function fetchHoldingsForTicker(ticker) {
  const linked = await q(
    `SELECT ih.institution_id, ih.institution_name, ih.issuer_name, ih.security_id, ih.report_date, ih.shares, ih.value, ih.portfolio_weight, ih.filing_id
     FROM institutional_holdings ih
     JOIN stock_security_links l ON l.security_id = ih.security_id
     JOIN stocks st ON st.id = l.stock_id
     WHERE st.ticker = $1`, [ticker]
  );
  const stockRows = await q(`SELECT id, company_name FROM stocks WHERE ticker=$1 AND company_name IS NOT NULL ORDER BY (country='US') DESC, is_active DESC LIMIT 1`, [ticker]);
  const companyName = stockRows[0]?.company_name;
  if (!companyName) return linked;
  const targetKey = normalizeIssuerName(companyName);
  if (!targetKey) return linked;
  const unlinked = await q(`SELECT institution_id, institution_name, issuer_name, security_id, report_date, shares, value, portfolio_weight, filing_id FROM institutional_holdings WHERE security_id IS NULL`);
  const fallbackMatches = unlinked.filter((row) => normalizeIssuerName(row.issuer_name) === targetKey);
  const seen = new Set(linked.map((r) => `${r.institution_id}:${r.filing_id}:${r.report_date}`));
  for (const row of fallbackMatches) {
    const key = `${row.institution_id}:${row.filing_id}:${row.report_date}`;
    if (!seen.has(key)) { seen.add(key); linked.push(row); }
  }
  return linked;
}

for (const ticker of ['NVDA', 'AAPL', 'MSFT', 'TSM', 'ASML']) {
  const rows = await fetchHoldingsForTicker(ticker);
  const managers = new Set(rows.map((r) => r.institution_id));
  const periods = new Set(rows.map((r) => r.report_date.toISOString().slice(0, 10)));
  console.log(ticker, '-> rows:', rows.length, '| distinct managers:', managers.size, '| periods:', [...periods].sort());
}

await client.end();
