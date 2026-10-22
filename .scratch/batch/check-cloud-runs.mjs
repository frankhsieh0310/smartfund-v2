import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const runs = (await c.query(
  `SELECT id, job_id, status, started_at::text, completed_at::text, details->>'trigger' trig, details->'checkpoint_after' cp
     FROM production_scheduler_runs WHERE job_id=$1 ORDER BY started_at DESC LIMIT 6`,
  ["YAHOO_ETF_FULL_SWEEP"],
)).rows;
console.log(JSON.stringify(runs, null, 1));
const cp = (await c.query(
  `SELECT checkpoint_key, last_symbol, processed, succeeded, failed, updated_at::text FROM production_scheduler_checkpoints WHERE checkpoint_key=$1`,
  ["yahoo-etf-full-sweep"],
)).rows[0];
console.log("CURRENT CHECKPOINT:", JSON.stringify(cp));
await c.end();
