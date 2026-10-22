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

const [{ c: before }] = await q("select count(*) c from institutional_holdings where security_id is not null");
const [{ c: total }] = await q('select count(*) c from institutional_holdings');

// --- full-dataset coverage stats (read-only) ---
const secByCusip = new Map((await q("select id, cusip from securities where cusip is not null and cusip<>''")).map((r) => [r.cusip, r.id]));
const stockRows = await q("select id, ticker, company_name, exchange, country from stocks where company_name is not null");
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
function resolveTicker(issuerName) {
  const key = normalizeName(issuerName);
  const usSet = usStocksByNormName.get(key);
  const allSet = stocksByNormName.get(key);
  const set = usSet && usSet.size >= 1 ? usSet : allSet;
  return set && set.size === 1 ? [...set][0] : null;
}

const allRows = await q('select id, issuer_name, cusip from institutional_holdings where security_id is null');
let tickerResolved = 0;
let cusipResolvable = 0;
for (const r of allRows) {
  if (secByCusip.has(r.cusip)) cusipResolvable++;
  if (resolveTicker(r.issuer_name)) tickerResolved++;
}
console.log('=== FULL-DATASET COVERAGE (read-only, before write) ===');
console.log({ total, alreadyHadSecurityId: before, nullRows: allRows.length, cusipResolvableToExistingSecurities: cusipResolvable, tickerResolvedViaNormalizedName: tickerResolved, tickerCoveragePct: (100 * tickerResolved / total).toFixed(1) + '%' });

// --- D. additive backfill: security_id, CUSIP-exact only, NULL rows only ---
const dryRun = process.argv.includes('--dry-run');
console.log(dryRun ? '\n--dry-run: no writes will be made' : '\nLIVE RUN: writing security_id + stock_security_links');

let updated = 0;
let linksInserted = 0;
if (!dryRun) {
  await client.query('BEGIN');
  try {
    const res = await client.query(`
      UPDATE institutional_holdings ih
      SET security_id = s.id, updated_at = now()
      FROM securities s
      WHERE ih.security_id IS NULL AND ih.cusip = s.cusip AND s.cusip IS NOT NULL AND s.cusip <> ''
    `);
    updated = res.rowCount;

    // Bridge each newly-anchored securities.id to a stocks.id via normalized issuer-name match,
    // additive only, skipping any (stock_id, security_id) pair that already exists.
    const anchored = await client.query(`
      SELECT DISTINCT ON (ih.security_id) ih.security_id, ih.issuer_name
      FROM institutional_holdings ih
      WHERE ih.security_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM stock_security_links l WHERE l.security_id = ih.security_id)
      ORDER BY ih.security_id, ih.issuer_name
    `);
    const seenPairs = new Set();
    for (const row of anchored.rows) {
      const ticker = resolveTicker(row.issuer_name);
      if (!ticker) continue;
      const stockIdRows = await client.query('SELECT id FROM stocks WHERE ticker=$1 LIMIT 1', [ticker]);
      const stockId = stockIdRows.rows[0]?.id;
      if (!stockId) continue;
      const pairKey = `${stockId}:${row.security_id}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      await client.query(
        `INSERT INTO stock_security_links (id, stock_id, security_id, mapping_source, verification_status, verified_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ISSUER_NAME_NORMALIZED_13F', 'INFERRED_NORMALIZED_NAME', now(), now(), now())
         ON CONFLICT (stock_id, security_id) DO NOTHING`,
        [stockId, row.security_id]
      );
      linksInserted++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

const [{ c: after }] = dryRun ? [{ c: before }] : await q('select count(*) c from institutional_holdings where security_id is not null');
console.log('\n=== D. BACKFILL RESULT ===');
console.log({ SECURITY_ID_BEFORE: before, SECURITY_ID_AFTER: after, rowsUpdatedThisRun: updated, stockSecurityLinksInserted: linksInserted, MAPPING_COVERAGE_PCT_security_id: (100 * after / total).toFixed(1) + '%' });

await client.end();
