import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const cp = (await c.query("SELECT * FROM production_scheduler_checkpoints WHERE checkpoint_key='yahoo-fund-full-sweep'")).rows[0];
console.log("checkpoint:", JSON.stringify(cp));

const runs = (await c.query("SELECT details FROM production_scheduler_runs WHERE job_id='YAHOO_FUND_FULL_SWEEP'")).rows;
let scIns=0, scUpd=0, mCreated=0, mLinked=0, navRows=0, distRows=0, holdRows=0, rateLimited=0, crumbRefresh=0, morningstarOk=0, navHistOk=0, holdOk=0, coreOk=0, failed=0, attempted=0;
for (const r of runs) {
  const d = r.details ?? {};
  scIns += d.share_class_inserted||0; scUpd += d.share_class_updated||0;
  mCreated += d.master_created||0; mLinked += d.master_linked||0;
  navRows += d.nav_rows_written||0; distRows += d.distribution_rows||0; holdRows += d.holdings_written||0;
  rateLimited += d.rate_limited||0; crumbRefresh += d.crumb_refresh||0;
  morningstarOk += d.morningstar_ok||0; navHistOk += d.nav_history_ok||0; holdOk += d.holdings_ok||0;
  coreOk += d.core_metadata_ok||0; failed += d.failed||0; attempted += d.attempted||0;
}
console.log(JSON.stringify({ scIns, scUpd, mCreated, mLinked, navRows, distRows, holdRows, rateLimited, crumbRefresh, morningstarOk, navHistOk, holdOk, coreOk, failed, attempted, slices: runs.length }));

const mastersTotal = (await c.query("SELECT count(*)::int n FROM fund_master WHERE provider_master_key LIKE 'YAHOO:%'")).rows[0];
console.log("fund_masters_total(yahoo):", JSON.stringify(mastersTotal));

const repairQ = (await c.query("SELECT count(*)::int n, count(*) FILTER (WHERE resolved)::int resolved_n FROM production_scheduler_failures WHERE job_id='YAHOO_FUND_ENRICH_REPAIR'")).rows[0];
console.log("fund repair queue:", JSON.stringify(repairQ));

// ETF sanity check (unaffected)
const etfCp = (await c.query("SELECT processed, succeeded, failed FROM production_scheduler_checkpoints WHERE checkpoint_key='yahoo-etf-full-sweep'")).rows[0];
const etfRepair = (await c.query("SELECT count(*)::int n, count(*) FILTER (WHERE resolved)::int resolved_n FROM production_scheduler_failures WHERE job_id='YAHOO_ETF_ENRICH_REPAIR'")).rows[0];
console.log("ETF sweep still healthy:", JSON.stringify(etfCp), "ETF repair:", JSON.stringify(etfRepair));

await c.end();
