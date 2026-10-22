import { Client } from 'pg';

const DEPLOY_CUTOFF = process.argv[2];
const MAX_WAIT_MS = 40 * 60 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;
const NEEDED_CLEAN_RUNS = 2;

const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const seenRunKeys = new Set();
const cleanRuns = [];
const start = Date.now();

while (Date.now() - start < MAX_WAIT_MS && cleanRuns.length < NEEDED_CLEAN_RUNS) {
  const r = await c.query(
    `SELECT run_key, status, error, inserted, updated,
       details->>'run_mode' AS run_mode, details->>'write_env_read_exactly_on' AS read_on,
       details->>'write_env_var_present' AS var_present, details->>'deployment_id' AS deployment_id
     FROM production_scheduler_runs WHERE job_id='MARKET_CLOSE_SYNC_SHADOW' AND started_at > $1::timestamptz ORDER BY started_at ASC`,
    [DEPLOY_CUTOFF],
  );
  for (const row of r.rows) {
    if (seenRunKeys.has(row.run_key)) continue;
    if (row.status === 'IN_PROGRESS') continue;
    seenRunKeys.add(row.run_key);
    const isClean = row.status !== 'FAILED' && !row.error;
    console.log(row.run_key, '| status:', row.status, '| error:', row.error, '| run_mode:', row.run_mode,
      '| read_exactly_on:', row.read_on, '| var_present:', row.var_present, '| deployment_id:', row.deployment_id,
      '| inserted:', row.inserted, '| updated:', row.updated, '| clean:', isClean);
    if (isClean) cleanRuns.push(row.run_key);
    else { console.log('GATE_FAIL'); await c.end(); process.exit(2); }
  }
  if (cleanRuns.length < NEEDED_CLEAN_RUNS) await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
}

console.log('CLEAN_RUNS:', cleanRuns);
console.log('GATE_RESULT:', cleanRuns.length >= NEEDED_CLEAN_RUNS ? 'PASS' : 'TIMEOUT');
await c.end();
process.exit(cleanRuns.length >= NEEDED_CLEAN_RUNS ? 0 : 1);
