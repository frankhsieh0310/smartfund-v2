import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const cp = (await c.query("SELECT last_symbol, processed FROM production_scheduler_checkpoints WHERE checkpoint_key=$1", ["yahoo-etf-full-sweep"])).rows[0];
console.log("checkpoint:", JSON.stringify(cp));

const cand = (await c.query(
  `SELECT id::text, code, data_source FROM etfs
    WHERE is_active = true AND id <= $1
      AND price_updated_at > now() - interval '3 hours'
      AND category IS NULL AND expense_ratio IS NULL AND aum IS NULL`,
  [cp.last_symbol],
)).rows;
console.log("candidate unresolved-enrich count:", cand.length);
console.log(JSON.stringify(cand.slice(0, 5)));

const apply = process.argv.includes("--apply");
if (apply) {
  let inserted = 0;
  for (const row of cand) {
    const sym = row.data_source && /^[A-Za-z0-9.^=-]{1,15}$/.test(row.data_source) ? row.data_source
      : (row.code && /^[A-Za-z0-9.^=-]{1,15}$/.test(row.code) ? row.code : null);
    if (!sym) continue;
    await c.query(
      `INSERT INTO production_scheduler_failures
         (job_id, stock_id, symbol, attempts, last_error, last_attempted_at, error_type, next_retry_at,
          classification, resolved, first_failed_at)
       VALUES ('YAHOO_ETF_ENRICH_REPAIR', $1, $2, 1, 'BACKFILLED_PRE_FIX_FAILURE', NOW(), 'BACKFILLED_PRE_FIX_FAILURE',
               NOW(), 'RETRYABLE_FAILURE', false, NOW())
       ON CONFLICT (job_id, stock_id) DO NOTHING`,
      [row.id, sym],
    );
    inserted++;
  }
  console.log("backfilled rows attempted:", inserted);
}
await c.end();
