import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await c.connect();
  const checks = [
    ["currency=TWD", `SELECT COUNT(*) c FROM etfs WHERE currency='TWD'`],
    ["currency=TWD + is_active", `SELECT COUNT(*) c FROM etfs WHERE currency='TWD' AND is_active=true`],
    ["currency=TWD + dividend_yield", `SELECT COUNT(*) c FROM etfs WHERE currency='TWD' AND dividend_yield IS NOT NULL`],
    ["currency=TWD + is_active + dividend_yield", `SELECT COUNT(*) c FROM etfs WHERE currency='TWD' AND is_active=true AND dividend_yield IS NOT NULL`],
    ["...+ nodot", `SELECT COUNT(*) c FROM etfs WHERE currency='TWD' AND is_active=true AND dividend_yield IS NOT NULL AND code !~ '\\.'`],
  ] as const;
  for (const [label, sql] of checks) {
    const r = await c.query(sql);
    console.log(label, r.rows[0].c);
  }
  const sample = await c.query(`SELECT code, is_active, currency FROM etfs WHERE currency='TWD' AND dividend_yield IS NOT NULL AND code !~ '\\.' LIMIT 10`);
  console.log("sample nodot TWD dividend rows:", JSON.stringify(sample.rows));
  await c.end();
}
main();
