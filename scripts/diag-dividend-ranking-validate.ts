import { Client } from "pg";

async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await c.connect();

  const yieldRows = await c.query(
    `SELECT e.code, e.name, (e.dividend_yield * 100)::text AS yield_pct,
            latest.amount::text AS latest_amount, latest.ex_date::text AS latest_ex_date
       FROM etfs e
       LEFT JOIN LATERAL (
         SELECT amount, ex_date FROM etf_distribution_events WHERE etf_id = e.id ORDER BY ex_date DESC LIMIT 1
       ) latest ON true
      WHERE e.is_active = true AND e.currency = 'TWD' AND e.code !~ '\\.' AND e.dividend_yield IS NOT NULL
      ORDER BY e.dividend_yield DESC NULLS LAST LIMIT 20`,
  );
  console.log("YIELD_RANKING_PASS:", yieldRows.rows.length === 20 ? "PASS" : `PARTIAL (${yieldRows.rows.length})`);
  console.log(JSON.stringify(yieldRows.rows.slice(0, 5), null, 2));

  const dividendRows = await c.query(
    `SELECT e.code, e.name, latest.amount::text AS latest_amount, latest.ex_date::text AS latest_ex_date
       FROM etfs e
       LEFT JOIN LATERAL (
         SELECT amount, ex_date FROM etf_distribution_events WHERE etf_id = e.id ORDER BY ex_date DESC LIMIT 1
       ) latest ON true
      WHERE e.is_active = true AND e.currency = 'TWD' AND e.code !~ '\\.' AND latest.amount IS NOT NULL
      ORDER BY latest.amount DESC NULLS LAST LIMIT 20`,
  );
  console.log("DIVIDEND_RANKING_PASS:", dividendRows.rows.length === 20 ? "PASS" : `PARTIAL (${dividendRows.rows.length})`);
  console.log(JSON.stringify(dividendRows.rows.slice(0, 5), null, 2));

  // spot check 3 real ETFs' full distribution history
  const spotCodes = ["0056", "00919", "00878"];
  for (const code of spotCodes) {
    const hist = await c.query(
      `SELECT d.ex_date::text, d.payment_date::text, d.amount::text, d.source
         FROM etf_distribution_events d JOIN etfs e ON e.id = d.etf_id
        WHERE e.code = $1 ORDER BY d.ex_date DESC LIMIT 5`,
      [code],
    );
    console.log(`DIVIDEND_HISTORY_${code}:`, hist.rows.length > 0 ? "PASS" : "NO_HISTORY", JSON.stringify(hist.rows));
  }

  await c.end();
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
