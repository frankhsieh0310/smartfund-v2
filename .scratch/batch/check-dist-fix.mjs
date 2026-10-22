import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const runs = (await c.query(
  `SELECT started_at::text, completed_at::text, status, details
     FROM production_scheduler_runs WHERE job_id='YAHOO_ETF_DISTRIBUTION_BACKFILL' AND started_at > '2026-09-11T14:26:00Z'
    ORDER BY started_at ASC`,
)).rows;
console.log(`post-fix slices: ${runs.length}`);
for (const r of runs) {
  const d = r.details ?? {};
  console.log(JSON.stringify({
    started: r.started_at, completed: r.completed_at, status: r.status,
    attempted: d.attempted, succeeded: d.succeeded, failed: d.failed,
    events_written: d.events_written, remaining: d.remaining, scan_complete: d.scan_complete,
    runtime_ms: d.runtime_ms, checkpoint_after: d.checkpoint_after,
  }));
}
const cp = (await c.query("SELECT * FROM production_scheduler_checkpoints WHERE checkpoint_key='yahoo-etf-distribution-backfill'")).rows[0];
console.log("checkpoint:", JSON.stringify(cp));
await c.end();
