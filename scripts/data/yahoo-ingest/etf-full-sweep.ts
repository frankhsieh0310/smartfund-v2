// ETF full-sweep runner — cloud-pattern logic replayed locally (same reason as replay-first-batch.ts:
// Prisma $queryRawUnsafe is unreliable from this Windows box; node-pg is a harness only, all real
// logic lives in lib/yahoo/*, identical to what /api/cron/yahoo-etf will run in production).
//
// Usage:
//   tsx scripts/data/yahoo-ingest/etf-full-sweep.ts --discover
//   tsx scripts/data/yahoo-ingest/etf-full-sweep.ts --sweep 1000
//
// --discover: enumerate the global Yahoo ETF universe (exchange-sharded), match against existing
//   `etfs`, insert verified net-new rows. Idempotent (ON CONFLICT (code) DO NOTHING + re-select).
// --sweep N: resumable history+enrich pass over ALL active etfs, cursor persisted in
//   production_scheduler_checkpoints (checkpoint_key='yahoo-etf-full-sweep-<phase>'). Cursor wraps to
//   NULL (one full lap complete) when a chunk returns fewer than N rows.

import { readFileSync } from "node:fs";
import pg from "pg";
import { discoverEtfUniverse, matchOrInsertEtf } from "../../../lib/yahoo/etfDiscovery";
import { enrichEtfProduct } from "../../../lib/yahoo/etfEnrich";
import { ingestEtfHistory } from "../../../lib/yahoo/etfHistory";
import { sleep, type RateStats } from "../../../lib/yahoo/productSession";

const url = readFileSync(new URL("../../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)![1];
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 4 });
const query = async (sql: string, params: unknown[] = []): Promise<any[]> => (await pool.query(sql, params as any[])).rows;

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,15}$/;

async function readCheckpoint(key: string) {
  const r = await query(`SELECT last_symbol, processed, succeeded, failed FROM production_scheduler_checkpoints WHERE checkpoint_key = $1`, [key]);
  return r[0] ?? null;
}
async function writeCheckpoint(key: string, jobId: string, runId: string, cp: { lastSymbol: string | null; processed: number; succeeded: number; failed: number }) {
  await query(
    `INSERT INTO production_scheduler_checkpoints (job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at, checkpoint_key)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), $7)
     ON CONFLICT (checkpoint_key) DO UPDATE SET
       run_id = EXCLUDED.run_id, last_symbol = EXCLUDED.last_symbol, processed = EXCLUDED.processed,
       succeeded = EXCLUDED.succeeded, failed = EXCLUDED.failed, updated_at = NOW()`,
    [jobId, runId, cp.lastSymbol, cp.processed, cp.succeeded, cp.failed, key],
  );
}

async function runDiscover() {
  const stats: RateStats = { calls: 0, rateLimited: 0, crumbRefresh: 0 };
  const existingBefore = (await query(`SELECT count(*)::int n FROM etfs WHERE is_active = true`))[0].n;
  console.log(`existing active ETFs before discovery: ${existingBefore}`);
  const disc = await discoverEtfUniverse({ perShardPages: 12, stats });
  console.log(`discovered ${disc.symbols.length} unique Yahoo ETF symbols across ${Object.keys(disc.perShardTotals).length} shards`);
  console.log("per_shard_totals:", JSON.stringify(disc.perShardTotals));

  let matched = 0, inserted = 0, failed = 0, notEtf = 0;
  const t0 = Date.now();
  for (let i = 0; i < disc.symbols.length; i++) {
    const sym = disc.symbols[i];
    if (!SYMBOL_RE.test(sym)) { failed++; continue; }
    try {
      const r = await matchOrInsertEtf(query, sym);
      if (r.matched) matched++;
      else if (r.inserted) inserted++;
      else if (r.error === "NOT_ETF_QUOTE_TYPE") notEtf++;
      else failed++;
    } catch (e) { failed++; console.error(sym, String(e).slice(0, 120)); }
    if ((i + 1) % 200 === 0) process.stdout.write(`  …${i + 1}/${disc.symbols.length}  matched ${matched}  inserted ${inserted}  failed ${failed}\n`);
    await sleep(250);
  }
  const existingAfter = (await query(`SELECT count(*)::int n FROM etfs WHERE is_active = true`))[0].n;
  console.log(JSON.stringify({
    ETF_DISCOVERED_TOTAL: disc.symbols.length,
    ETF_MATCHED_EXISTING: matched,
    ETF_NET_NEW_INSERTED: inserted,
    ETF_NOT_ETF_QUOTE_TYPE_SKIPPED: notEtf,
    ETF_DISCOVER_FAILED: failed,
    ETF_TOTAL_BEFORE: existingBefore,
    ETF_TOTAL_AFTER: existingAfter,
    runtime_s: ((Date.now() - t0) / 1000) | 0,
    stats,
  }, null, 2));
}

async function runSweep(n: number) {
  const stats: RateStats = { calls: 0, rateLimited: 0, crumbRefresh: 0 };
  const key = "yahoo-etf-full-sweep";
  const jobId = "YAHOO_ETF_FULL_SWEEP";
  const runId = `local-${Date.now()}`;
  const cpBefore = await readCheckpoint(key);
  const cursor: string | null = cpBefore?.last_symbol ?? null;
  console.log(`resuming from cursor=${cursor ?? "(start)"}  processed-so-far=${cpBefore?.processed ?? 0}`);

  const rows = await query(
    `SELECT id::text, code, data_source,
            CASE WHEN data_source ~ '^[A-Za-z0-9.^=-]{1,15}$' THEN data_source
                 WHEN code ~ '^[A-Za-z0-9.^=-]{1,15}$' THEN code ELSE NULL END AS symbol
       FROM etfs
      WHERE is_active = true AND ($1::text IS NULL OR id > $1)
      ORDER BY id
      LIMIT $2`,
    [cursor, n],
  );

  let attempted = 0, histOk = 0, enrOk = 0, histRows = 0, holdRows = 0, perfRows = 0, distEvents = 0, failed = 0, noSym = 0;
  let lastId: string | null = cursor;
  const t0 = Date.now();
  for (const e of rows) {
    lastId = e.id;
    attempted++;
    const sym = String(e.symbol ?? "").trim();
    if (!sym) { noSym++; continue; }
    try {
      const h = await ingestEtfHistory(query, { etfId: e.id, symbol: sym });
      if (h.ok) { histOk++; histRows += h.rowsWritten; distEvents += h.distributionEvents; } else failed++;
      const p = await enrichEtfProduct(query, { etfId: e.id, symbol: sym });
      if (p.ok) { enrOk++; holdRows += p.holdingsWritten; perfRows += p.performanceWritten; } else failed++;
    } catch (err) { failed++; console.error(e.code, String(err).slice(0, 120)); }
    if (attempted % 50 === 0) process.stdout.write(`  …${attempted}/${rows.length}  hist ${histOk}  enrich ${enrOk}  failed ${failed}\n`);
    await sleep(600);
  }

  const wrapped = rows.length < n;
  const cpAfter = {
    lastSymbol: wrapped ? null : lastId,
    processed: (cpBefore?.processed ?? 0) + attempted,
    succeeded: (cpBefore?.succeeded ?? 0) + histOk,
    failed: (cpBefore?.failed ?? 0) + failed,
  };
  await writeCheckpoint(key, jobId, runId, cpAfter);
  console.log(JSON.stringify({
    SWEEP_CHUNK_ATTEMPTED: attempted, SWEEP_HISTORY_OK: histOk, SWEEP_ENRICH_OK: enrOk,
    SWEEP_HISTORY_ROWS: histRows, SWEEP_HOLDINGS_ROWS: holdRows, SWEEP_PERF_ROWS: perfRows,
    SWEEP_DISTRIBUTION_EVENTS: distEvents, SWEEP_FAILED: failed, SWEEP_NO_SYMBOL: noSym,
    WRAPPED_FULL_LAP: wrapped,
    CUMULATIVE_PROCESSED: cpAfter.processed, CUMULATIVE_SUCCEEDED: cpAfter.succeeded, CUMULATIVE_FAILED: cpAfter.failed,
    runtime_s: ((Date.now() - t0) / 1000) | 0, stats,
  }, null, 2));
}

(async () => {
  if (process.argv.includes("--discover")) await runDiscover();
  const sw = arg("sweep");
  if (sw) await runSweep(Number(sw));
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
