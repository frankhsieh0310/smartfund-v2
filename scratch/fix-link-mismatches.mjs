import 'dotenv/config';
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

// Bug found during verification: the original backfill's stock_id lookup
// (`SELECT id FROM stocks WHERE ticker=$1 LIMIT 1`) had no US/exchange preference, unlike the
// live API's resolveTickerForStock(). For any ticker shared by a US company and a foreign
// micro-cap/cross-listing (e.g. DAL = Delta Air Lines (US) vs Dalaroo Metals Ltd (AU)), it could
// pick the wrong stocks row — correct 13F financial data, but the WRONG company_name shown next
// to it. This corrects stock_security_links to point at the same US-preferred row the API uses,
// so display and identity are consistent. No schema change; only stock_id on existing rows.
const rows = await q(`
  select l.id link_id, l.security_id, l.stock_id as current_stock_id, cur.ticker
  from stock_security_links l
  join stocks cur on cur.id = l.stock_id
  where l.mapping_source='ISSUER_NAME_NORMALIZED_13F'
`);

let fixed = 0;
let skippedConflict = 0;
await client.query('BEGIN');
try {
  for (const r of rows) {
    const better = await q(`select id from stocks where ticker=$1 order by (country='US') desc, is_active desc limit 1`, [r.ticker]);
    const betterId = better[0]?.id;
    if (!betterId || betterId === r.current_stock_id) continue;
    const conflict = await q(`select 1 from stock_security_links where stock_id=$1 and security_id=$2`, [betterId, r.security_id]);
    if (conflict.length) {
      // Correct target already linked from another row (e.g. two issuer-name variants for the
      // same security both got processed) — drop this now-redundant/wrong duplicate instead.
      await client.query(`delete from stock_security_links where id=$1`, [r.link_id]);
      skippedConflict++;
      continue;
    }
    await client.query(`update stock_security_links set stock_id=$1, updated_at=now() where id=$2`, [betterId, r.link_id]);
    fixed++;
  }
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
}
console.log({ totalChecked: rows.length, fixed, removedAsDuplicate: skippedConflict });
await client.end();
