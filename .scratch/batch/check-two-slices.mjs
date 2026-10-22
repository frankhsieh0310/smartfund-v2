import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const runs = (await c.query(
  `SELECT started_at::text, completed_at::text, details
     FROM production_scheduler_runs WHERE job_id=$1 AND status='COMPLETED'
    ORDER BY started_at ASC`,
  ["YAHOO_ETF_FULL_SWEEP"],
)).rows;
for (const r of runs) {
  const d = r.details;
  console.log(JSON.stringify({
    started: r.started_at, completed: r.completed_at,
    attempted: d.attempted, history_ok: d.history_ok, enrich_ok: d.enrich_ok, failed: d.failed,
    rate_limited: d.rate_limited, crumb_refresh: d.crumb_refresh,
    checkpoint_before: d.checkpoint_before, checkpoint_after: d.checkpoint_after,
  }, null, 1));
}
const cp = (await c.query(
  `SELECT last_symbol, processed, succeeded, failed, updated_at::text FROM production_scheduler_checkpoints WHERE checkpoint_key=$1`,
  ["yahoo-etf-full-sweep"],
)).rows[0];
console.log("LIVE_CHECKPOINT:", JSON.stringify(cp));
await c.end();
