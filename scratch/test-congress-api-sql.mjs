import 'dotenv/config';
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

async function fetchRows(where, params) {
  return q(
    `SELECT t.id, p.name AS person_name, p.chamber, p.state, p.party,
            t.asset_name, t.ticker, t.transaction_type, t.transaction_date, t.disclosure_date,
            t.amount_min, t.amount_max, t.owner, t.source_url, t.mapping_method
     FROM political_transactions t
     JOIN political_persons p ON p.id = t.person_id
     ${where}
     ORDER BY t.disclosure_date DESC, t.transaction_date DESC
     LIMIT 100`,
    params
  );
}
console.log('latest', (await fetchRows('', [])).length);
console.log('by ticker NKE', (await fetchRows('WHERE t.ticker = $1', ['NKE'])).length);
console.log('buys', (await fetchRows("WHERE t.transaction_type = 'P'", [])).length);
console.log('by person', (await fetchRows('WHERE p.name ILIKE $1', ['%Cisneros%'])).length);
const coverage = await q(`SELECT count(DISTINCT person_id) AS people, count(*) AS transactions, max(disclosure_date) AS latest_disclosure FROM political_transactions`);
console.log('coverage', coverage);
await client.end();
