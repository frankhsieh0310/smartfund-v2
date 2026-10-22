import { Client } from 'pg';

const MAX_WAIT_MS = 60 * 60 * 1000; // up to 1 hour to collect 3 consecutive clean runs
const POLL_INTERVAL_MS = 30 * 1000;
const NEEDED_CLEAN_RUNS = 3;
const TARGET_MARKETS = new Set(['nyse-yahoo-daily', 'hong-kong-yahoo-daily', 'united-kingdom-yahoo-daily']);

const DEPLOY_CUTOFF = process.argv[2]; // ISO timestamp — only count runs started strictly after this
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const seenRunKeys = new Set();
let cleanRuns = [];
const marketsCovered = new Set();
const start = Date.now();

while (Date.now() - start < MAX_WAIT_MS && cleanRuns.length < NEEDED_CLEAN_RUNS) {
  const r = await c.query(
    `SELECT run_key, status, started_at, completed_at, error, details->'markets' AS markets, details->>'deployment_id' AS deployment_id
     FROM production_scheduler_runs WHERE job_id='MARKET_CLOSE_SYNC_SHADOW' AND started_at > $1::timestamptz ORDER BY started_at ASC`,
    [DEPLOY_CUTOFF],
  );
  for (const row of r.rows) {
    if (seenRunKeys.has(row.run_key)) continue;
    if (row.status === 'IN_PROGRESS') continue; // not finished yet, check again later
    seenRunKeys.add(row.run_key);
    const isClean = row.status !== 'FAILED' && !row.error;
    console.log(row.run_key, '| status:', row.status, '| error:', row.error, '| deployment_id:', row.deployment_id, '| clean:', isClean);
    if (isClean) {
      cleanRuns.push(row.run_key);
      for (const m of row.markets ?? []) {
        if (TARGET_MARKETS.has(m.jobId) && (m.requested || 0) > 0) marketsCovered.add(m.jobId);
      }
    } else {
      console.log('GATE_FAIL: non-clean run detected:', row.run_key, row.error);
      await c.end();
      process.exit(2);
    }
  }
  if (cleanRuns.length < NEEDED_CLEAN_RUNS) await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
}

console.log('CLEAN_RUNS:', cleanRuns);
console.log('MARKETS_COVERED (of target 3):', [...marketsCovered]);
console.log('GATE_RESULT:', cleanRuns.length >= NEEDED_CLEAN_RUNS ? 'PASS' : 'TIMEOUT');
await c.end();
process.exit(cleanRuns.length >= NEEDED_CLEAN_RUNS ? 0 : 1);
