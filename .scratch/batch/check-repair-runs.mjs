import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const runs = (await c.query(
  `SELECT started_at::text, status, details FROM production_scheduler_runs WHERE job_id=$1 ORDER BY started_at ASC`,
  ["YAHOO_ETF_ENRICH_REPAIR"],
)).rows;
console.log(`repair slices so far: ${runs.length}`);
for (const r of runs) {
  const d = r.details ?? {};
  console.log(JSON.stringify({
    started: r.started_at, status: r.status, attempted: d.attempted, repaired: d.repaired,
    holdings_also_ok: d.holdings_also_ok, still_failing: d.still_failing, marked_not_available: d.marked_not_available,
    remaining_in_queue: d.remaining_in_queue, enrich_failures: d.enrich_failures,
  }));
}
await c.end();
