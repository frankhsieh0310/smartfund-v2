// P0-3A — bounded issuer universe expansion: top 150 US large caps by SEC's own company_tickers.json
// ordering (official SEC ticker->CIK registry, ordered by market cap descending — not a guess, not
// a hand-picked list). Populates insider_ownership_eligible_issuers with the SAME schema/shape as
// the existing 10 rows (additive only — never overwrites an existing eligible issuer's rank/status).
import 'dotenv/config';
import pg from 'pg';

const TARGET_COUNT = 150;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

const res = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'user-agent': 'SmartFund research@smartfund.local' } });
if (!res.ok) throw new Error(`SEC company_tickers.json fetch failed: HTTP ${res.status}`);
const registry = await res.json();
const candidates = Object.values(registry).slice(0, TARGET_COUNT); // already market-cap ordered by SEC

// insider_ownership_eligible_issuers.security_id FKs to `securities`, not `stocks` (confirmed via
// the existing 10 rows: their security_id resolves in `securities` with a real ticker+exchange,
// e.g. AAPL -> securities row with exchange='NASDAQ' — a different `securities` population than the
// ticker-less CUSIP-only rows used for 13F institutional_holdings identity).
const secRows = await q(`select id, ticker, exchange from securities where ticker is not null`);
const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'NYSEARCA', 'ARCA', 'AMEX', 'BATS', 'IEX']);
const secByTicker = new Map();
for (const s of secRows) {
  if (!secByTicker.has(s.ticker) || US_EXCHANGES.has(s.exchange)) secByTicker.set(s.ticker, s.id);
}
const stockByTicker = secByTicker;

const existing = await q(`select ticker from insider_ownership_eligible_issuers`);
const existingTickers = new Set(existing.map((r) => r.ticker));

let inserted = 0, skippedNoSecurity = 0, skippedExisting = 0;
let rank = (await q(`select coalesce(max(deterministic_rank),0) m from insider_ownership_eligible_issuers`))[0].m;
const results = [];
for (const co of candidates) {
  const ticker = co.ticker;
  if (existingTickers.has(ticker)) { skippedExisting++; continue; }
  const securityId = stockByTicker.get(ticker);
  if (!securityId) { skippedNoSecurity++; continue; }
  rank++;
  await client.query(
    `insert into insider_ownership_eligible_issuers
      (security_id, cik, ticker, market, jurisdiction, source_status, eligibility_status,
       no_ownership_event_found_verified, source_constrained, license_constrained, deterministic_rank, source, checked_at)
     values ($1,$2,$3,'US_LISTED','US','PUBLIC_OFFICIAL','SOURCE_READY',false,false,false,$4,'SEC_EDGAR',now())
     on conflict do nothing`,
    [securityId, String(co.cik_str).padStart(10, '0'), ticker, rank]
  );
  inserted++;
  results.push(ticker);
}

console.log(JSON.stringify({ target: TARGET_COUNT, inserted, skippedExisting, skippedNoSecurity, sample: results.slice(0, 20) }, null, 2));
await client.end();
