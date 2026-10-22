import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await c.connect();
  const count = await c.query(
    `SELECT COUNT(*) c
       FROM etfs e
       LEFT JOIN LATERAL (
         SELECT amount, ex_date FROM etf_distribution_events WHERE etf_id = e.id ORDER BY ex_date DESC LIMIT 1
       ) latest ON true
      WHERE e.is_active = true AND e.currency = 'TWD' AND e.code !~ '\\.' AND e.dividend_yield IS NOT NULL`,
  );
  console.log("count with lateral", count.rows[0].c);
  const full = await c.query(
    `SELECT e.code, e.name, (e.dividend_yield * 100)::text AS yield_pct
       FROM etfs e
       LEFT JOIN LATERAL (
         SELECT amount, ex_date FROM etf_distribution_events WHERE etf_id = e.id ORDER BY ex_date DESC LIMIT 1
       ) latest ON true
      WHERE e.is_active = true AND e.currency = 'TWD' AND e.code !~ '\\.' AND e.dividend_yield IS NOT NULL
      ORDER BY e.dividend_yield DESC NULLS LAST LIMIT 20`,
  );
  console.log("full rows", full.rows.length, JSON.stringify(full.rows.slice(0, 3)));
  await c.end();
}
main().catch((e) => console.error("ERR", e));
