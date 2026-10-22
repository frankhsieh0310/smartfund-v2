import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const runs = (await c.query(
  `SELECT started_at::text, completed_at::text, status, details
     FROM production_scheduler_runs WHERE job_id=$1
    ORDER BY started_at ASC`,
  ["YAHOO_ETF_FULL_SWEEP"],
)).rows;
console.log(`total slices so far: ${runs.length}`);
for (const r of runs) {
  const d = r.details ?? {};
  console.log(JSON.stringify({
    started: r.started_at, status: r.status,
    attempted: d.attempted, history_ok: d.history_ok, enrich_core_ok: d.enrich_core_ok, holdings_ok: d.holdings_ok,
    failed: d.failed, enrich_failures: d.enrich_failures,
    auth_cookie_present: d.auth_cookie_present, auth_crumb_present: d.auth_crumb_present, auth_failure_reason: d.auth_failure_reason,
  }));
}
const repairQ = await c.query(
  `SELECT count(*)::int n FROM production_scheduler_failures WHERE job_id='YAHOO_ETF_ENRICH_REPAIR' AND resolved=false`,
);
console.log("REPAIR_QUEUE_PENDING:", repairQ.rows[0].n);
await c.end();
