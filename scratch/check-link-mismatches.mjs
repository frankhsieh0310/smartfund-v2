import 'dotenv/config';
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

const rows = await q(`
  select l.id link_id, l.security_id, l.stock_id as current_stock_id, cur.ticker, cur.company_name as current_name, cur.country as current_country, cur.exchange as current_exchange
  from stock_security_links l
  join stocks cur on cur.id = l.stock_id
  where l.mapping_source='ISSUER_NAME_NORMALIZED_13F'
`);
let mismatches = [];
for (const r of rows) {
  const better = await q(`select id, company_name, country, exchange from stocks where ticker=$1 order by (country='US') desc, is_active desc limit 1`, [r.ticker]);
  if (better[0] && better[0].id !== r.current_stock_id) {
    mismatches.push({ link_id: r.link_id, ticker: r.ticker, current_stock_id: r.current_stock_id, current_name: r.current_name, current_country: r.current_country, better_stock_id: better[0].id, better_name: better[0].company_name, better_country: better[0].country });
  }
}
console.log('total links checked:', rows.length);
console.log('mismatches found:', mismatches.length);
console.log(JSON.stringify(mismatches, null, 2));
await client.end();
