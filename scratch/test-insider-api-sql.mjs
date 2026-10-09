import 'dotenv/config';
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

const CODE_MAP = { P: 'OPEN_MARKET_PURCHASE', S: 'OPEN_MARKET_SALE', M: 'OPTION_EXERCISE', C: 'OPTION_EXERCISE', X: 'OPTION_EXERCISE', A: 'GRANT_AWARD', G: 'GIFT' };
const bucketOf = (c) => CODE_MAP[c] ?? 'OTHER';

for (const ticker of ['NVDA', 'AAPL', 'META', 'MU', 'GOOGL', 'AMZN']) {
  const rows = await q(
    `SELECT t.transaction_type, t.insider, t.shares, t.price, t.transaction_date
     FROM insider_ownership_transactions t JOIN securities s ON s.id = t.security_id
     WHERE s.ticker = $1 ORDER BY t.transaction_date DESC LIMIT 200`,
    [ticker]
  );
  const buys = rows.filter((r) => r.transaction_type === 'P').length;
  const sells = rows.filter((r) => r.transaction_type === 'S').length;
  const other = rows.length - buys - sells;
  console.log(`${ticker}: total=${rows.length} true_buys(P)=${buys} true_sells(S)=${sells} other_buckets=${other} | codes=${[...new Set(rows.map(r=>r.transaction_type))].join(',')}`);
}
await client.end();
