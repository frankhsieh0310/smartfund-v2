import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const repaired = (await c.query(
  `SELECT stock_id, symbol FROM production_scheduler_failures
     WHERE job_id='YAHOO_ETF_ENRICH_REPAIR' AND resolved=true AND resolution_reason='REPAIRED'
     ORDER BY last_attempted_at DESC LIMIT 20`,
)).rows;
console.log("sample size:", repaired.length);

let mappingOk = 0, dupSnap = 0, badWeight = 0;
for (const r of repaired) {
  const etf = (await c.query(`SELECT code, data_source, category, name_en, expense_ratio FROM etfs WHERE id=$1`, [r.stock_id])).rows[0];
  if (etf && (etf.data_source === r.symbol || etf.code === r.symbol)) mappingOk++;
  const snaps = (await c.query(
    `SELECT count(*)::int n FROM etf_holding_snapshots WHERE etf_id=$1 AND source='YAHOO_QUOTE_SUMMARY' AND effective_date IS NULL AND source_record_id LIKE 'YAHOO:%:'||to_char(current_date,'YYYY-MM-DD')`,
    [r.stock_id],
  )).rows[0];
  if (snaps.n > 1) dupSnap++;
  console.log(r.symbol, JSON.stringify(etf));
}
console.log(JSON.stringify({ sample: repaired.length, MAPPING_OK: mappingOk, DUP_SNAPSHOT: dupSnap }));
await c.end();
