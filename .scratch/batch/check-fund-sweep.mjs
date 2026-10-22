import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const disc = (await c.query(
  `SELECT started_at::text, status, details->'symbols' IS NOT NULL as has_symbols,
          jsonb_array_length(COALESCE(details->'symbols','[]'::jsonb)) as n
     FROM production_scheduler_runs WHERE job_id='YAHOO_FUND_UNIVERSE_DISCOVERY' ORDER BY started_at DESC LIMIT 1`,
)).rows[0];
console.log("discovery:", JSON.stringify(disc));

const runs = (await c.query(
  `SELECT started_at::text, status, details FROM production_scheduler_runs
     WHERE job_id='YAHOO_FUND_FULL_SWEEP' ORDER BY started_at ASC`,
)).rows;
console.log(`sweep slices so far: ${runs.length}`);
for (const r of runs) {
  const d = r.details ?? {};
  console.log(JSON.stringify({
    started: r.started_at, status: r.status, attempted: d.attempted,
    core_metadata_ok: d.core_metadata_ok, morningstar_ok: d.morningstar_ok,
    nav_history_ok: d.nav_history_ok, holdings_ok: d.holdings_ok, failed: d.failed,
    enrich_failures: d.enrich_failures, wrapped: d.wrapped,
  }));
}
const cp = (await c.query("SELECT * FROM production_scheduler_checkpoints WHERE checkpoint_key='yahoo-fund-full-sweep'")).rows[0];
console.log("checkpoint:", JSON.stringify(cp));
await c.end();
