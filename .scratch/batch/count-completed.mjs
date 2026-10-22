import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(
  "SELECT count(*)::int n FROM production_scheduler_runs WHERE job_id=$1 AND status='COMPLETED'",
  ["YAHOO_ETF_FULL_SWEEP"],
);
console.log(r.rows[0].n);
await c.end();
