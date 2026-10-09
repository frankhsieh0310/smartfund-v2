// Task 4 — fix House PTR owner parsing. Official House Clerk PTR convention prefixes the asset
// name with an owner code when the holding is not the filer's own: "JT" (Joint), "SP" (Spouse),
// "DC" (Dependent Child); no prefix means the filer themself (Self). This is a real, documented
// field convention — not a guess. Idempotent: UPDATEs owner on existing rows by id, never inserts,
// never touches asset_name/dedup key, so no duplicate transactions can be created. No re-fetch.
import 'dotenv/config';
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

const OWNER_CODES = { JT: 'Joint', SP: 'Spouse', DC: 'Dependent Child' };

const [{ c: before }] = await q(`select count(*) c from political_transactions where owner is not null`);

const rows = await q(`select id, asset_name from political_transactions`);
let updated = 0;
const breakdown = { Self: 0, Joint: 0, Spouse: 0, 'Dependent Child': 0, Unknown: 0 };
for (const row of rows) {
  const m = row.asset_name.match(/^(JT|SP|DC)\s+/);
  const owner = m ? OWNER_CODES[m[1]] : 'Self';
  breakdown[owner] = (breakdown[owner] ?? 0) + 1;
  await client.query(`update political_transactions set owner = $1, updated_at = now() where id = $2`, [owner, row.id]);
  updated++;
}

const [{ c: after }] = await q(`select count(*) c from political_transactions where owner is not null`);
const [{ c: totalNow }] = await q(`select count(*) c from political_transactions`);

console.log(JSON.stringify({ HOUSE_OWNER_BEFORE: Number(before), HOUSE_OWNER_AFTER: Number(after), rowsUpdated: updated, totalRowsUnchanged: Number(totalNow) === rows.length, breakdown }, null, 2));
await client.end();
