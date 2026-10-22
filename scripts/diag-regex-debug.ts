import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await c.connect();
  const a = await c.query(`SELECT COUNT(*) c FROM etfs WHERE code !~ '\\.'`);
  console.log("with backslash-dot filter (no-dot codes count):", a.rows[0].c);
  const b = await c.query(`SELECT COUNT(*) c FROM etfs WHERE code LIKE '%.%'`);
  console.log("codes containing a literal dot (LIKE):", b.rows[0].c);
  const sample = await c.query(`SELECT code FROM etfs LIMIT 5`);
  console.log("sample codes:", JSON.stringify(sample.rows));
  await c.end();
}
main();
