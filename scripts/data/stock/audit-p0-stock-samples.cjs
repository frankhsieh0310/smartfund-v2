const { Client } = require("pg");

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 30_000 });
  await db.connect();
  try {
    await db.query("BEGIN READ ONLY");
    const samples = await db.query(`
      SELECT s.symbol, count(h.stock_id)::int AS rows,
             min(h.date)::text AS earliest, max(h.date)::text AS latest
      FROM stocks s LEFT JOIN stock_history h ON h.stock_id=s.id
      WHERE s.symbol=ANY($1)
      GROUP BY s.symbol ORDER BY s.symbol`,
      [["AAPL", "MSFT", "NVDA", "2330.TW", "9962.TWO", "IBM", "QCOM", "UUUU", "000001.SZ"]]);
    const sourceLimited = await db.query(`
      SELECT s.symbol, count(h.stock_id)::int AS rows,
             min(h.date)::text AS earliest, max(h.date)::text AS latest
      FROM stocks s LEFT JOIN stock_history h ON h.stock_id=s.id
      WHERE s.id=$1 GROUP BY s.symbol`, ["5471d746-24cb-4d4b-a6e8-1594135f20af"]);
    const ipo = await db.query(`
      SELECT s.symbol, o.expected_listing_date::text AS listing_date,
             count(h.stock_id)::int AS rows, min(h.date)::text AS earliest,
             max(h.date)::text AS latest
      FROM ipo_stock_mappings m JOIN ipo_offerings o ON o.id=m.ipo_id
      JOIN stocks s ON s.id=m.stock_id LEFT JOIN stock_history h ON h.stock_id=s.id
      WHERE m.status='VERIFIED'
      GROUP BY s.symbol,o.expected_listing_date ORDER BY o.expected_listing_date DESC LIMIT 1`);
    await db.query("COMMIT");
    console.log(JSON.stringify({ samples: samples.rows, sourceLimited: sourceLimited.rows, ipo: ipo.rows }, null, 2));
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { await db.end(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
