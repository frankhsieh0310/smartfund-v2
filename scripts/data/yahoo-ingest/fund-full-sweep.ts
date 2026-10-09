// US mutual-fund full-sweep runner (same node-pg-harness-over-lib-code pattern as etf-full-sweep.ts).
//
// Usage:
//   tsx scripts/data/yahoo-ingest/fund-full-sweep.ts --discover
//   tsx scripts/data/yahoo-ingest/fund-full-sweep.ts --sweep 300
//
// --discover: enumerate the Yahoo US-region mutual-fund universe, save the deduped symbol list to
//   .scratch/batch/fund-full-sweep-symbols.json (discovery itself is cheap; re-running --sweep should
//   not have to re-discover every chunk).
// --sweep N: resumable ingest over the saved symbol list. Cursor = index into that list, persisted in
//   production_scheduler_checkpoints (checkpoint_key='yahoo-fund-full-sweep', last_symbol=index as text).
//   Every N=1000 processed, runs a quality spot-check (WRONG_MASTER_MERGES / UNLINKED_CLASSES /
//   DUP_HOLDINGS_PER_MASTER) and aborts the chunk if wrong merges are found (per the mandate: pause,
//   fix, resume — never silently keep merging).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import pg from "pg";
import { discoverAllUsFunds, enrichFundFromYahoo, ingestUsFundShareClass, masterStem } from "../../../lib/yahoo/fundIngest";
import { sleep, type RateStats } from "../../../lib/yahoo/productSession";

const url = readFileSync(new URL("../../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)![1];
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 4 });
const query = async (sql: string, params: unknown[] = []): Promise<any[]> => (await pool.query(sql, params as any[])).rows;

const SYMS_FILE = new URL("../../../.scratch/batch/fund-full-sweep-symbols.json", import.meta.url);
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

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
  const t0 = Date.now();
  const disc = await discoverAllUsFunds({ stats });
  writeFileSync(SYMS_FILE, JSON.stringify({ symbols: disc.symbols, discoveredAt: new Date().toISOString() }));
  console.log(JSON.stringify({
    FUND_DISCOVERED_TOTAL: disc.symbols.length,
    TOP_PASS_COUNT: disc.topPassCount,
    PER_CATEGORY_TOTALS: disc.perCategoryTotals,
    runtime_s: ((Date.now() - t0) / 1000) | 0,
    stats,
  }, null, 2));
}

async function qualityCheck(): Promise<{ wrongMerges: number; unlinked: number; dupHoldings: number }> {
  const rows = await query(
    `SELECT sc.master_fund_id, f.name FROM fund_share_classes sc JOIN funds f ON f.id = sc.fund_id
      WHERE sc.source = 'YAHOO_US_MF_V1' AND sc.updated_at > now() - interval '2 hours'`,
  );
  const byMaster: Record<string, string[]> = {};
  let unlinked = 0;
  for (const r of rows) {
    if (!r.master_fund_id) { unlinked++; continue; }
    (byMaster[r.master_fund_id] ??= []).push(r.name);
  }
  let wrongMerges = 0;
  for (const names of Object.values(byMaster)) {
    if (new Set(names.map(masterStem)).size > 1) wrongMerges++;
  }
  const dup = await query(
    `SELECT fund_id, rank, count(*)::int n FROM holdings
      WHERE source = 'YAHOO_QUOTE_SUMMARY' AND as_of_date = current_date
      GROUP BY fund_id, rank HAVING count(*) > 1 LIMIT 10`,
  );
  return { wrongMerges, unlinked, dupHoldings: dup.length };
}

async function runSweep(n: number) {
  if (!existsSync(SYMS_FILE)) { console.error("Run --discover first."); process.exit(1); }
  const { symbols } = JSON.parse(readFileSync(SYMS_FILE, "utf8")) as { symbols: string[] };
  const key = "yahoo-fund-full-sweep";
  const jobId = "YAHOO_FUND_FULL_SWEEP";
  const runId = `local-${Date.now()}`;
  const cpBefore = await readCheckpoint(key);
  const startIdx = cpBefore?.last_symbol ? Number(cpBefore.last_symbol) : 0;
  console.log(`resuming from index=${startIdx}/${symbols.length}  processed-so-far=${cpBefore?.processed ?? 0}`);

  const slice = symbols.slice(startIdx, startIdx + n);
  const mastersHoldings = new Set<string>();
  let ok = 0, failed = 0, scIns = 0, scUpd = 0, mCreated = 0, mLinked = 0, navRows = 0, dist = 0, holdRows = 0;
  let msO = 0, msR = 0, msC = 0;
  const t0 = Date.now();
  for (let i = 0; i < slice.length; i++) {
    const sym = slice[i];
    try {
      const rec = await enrichFundFromYahoo(sym);
      if (!rec) { failed++; continue; }
      const r = await ingestUsFundShareClass(query, rec, mastersHoldings);
      if (r.ok) {
        ok++;
        if (r.shareClassInserted) scIns++;
        if (r.shareClassUpdated) scUpd++;
        if (r.masterCreated) mCreated++;
        if (r.masterLinked) mLinked++;
        navRows += r.navRowsWritten; dist += r.distributionRows; holdRows += r.holdingsWritten;
        if (r.morningstar.overall != null) msO++;
        if (r.morningstar.risk != null) msR++;
        if (r.morningstar.category) msC++;
      } else failed++;
    } catch { failed++; }
    if ((i + 1) % 50 === 0) process.stdout.write(`  …${startIdx + i + 1}/${symbols.length}  ok ${ok}  SC+${scIns} master+${mCreated}\n`);
    await sleep(900);
  }

  const newIdx = startIdx + slice.length;
  const wrapped = newIdx >= symbols.length;
  const cpAfter = {
    lastSymbol: wrapped ? "0" : String(newIdx),
    processed: (cpBefore?.processed ?? 0) + slice.length,
    succeeded: (cpBefore?.succeeded ?? 0) + ok,
    failed: (cpBefore?.failed ?? 0) + failed,
  };
  const qc = await qualityCheck();
  await writeCheckpoint(key, jobId, runId, cpAfter);
  console.log(JSON.stringify({
    SWEEP_CHUNK_ATTEMPTED: slice.length, SWEEP_OK: ok, SWEEP_FAILED: failed,
    SHARE_CLASS_INSERTED: scIns, SHARE_CLASS_UPDATED: scUpd, MASTER_CREATED: mCreated, MASTER_LINKED: mLinked,
    NAV_ROWS_WRITTEN: navRows, DISTRIBUTION_ROWS: dist, MASTER_HOLDINGS_WRITTEN: holdRows,
    MORNINGSTAR_RATING_POPULATED: msO, MORNINGSTAR_RISK_POPULATED: msR, MORNINGSTAR_CATEGORY_POPULATED: msC,
    WRAPPED_FULL_LAP: wrapped, INDEX_AFTER: newIdx, UNIVERSE_SIZE: symbols.length,
    CUMULATIVE_PROCESSED: cpAfter.processed, CUMULATIVE_SUCCEEDED: cpAfter.succeeded, CUMULATIVE_FAILED: cpAfter.failed,
    QUALITY_CHECK_LAST_2H: qc,
    runtime_s: ((Date.now() - t0) / 1000) | 0,
  }, null, 2));
  if (qc.wrongMerges > 0) {
    console.error(`PAUSE: ${qc.wrongMerges} wrong master merge(s) detected in the last 2h window — stop expansion, fix masterStem rules, resume.`);
    process.exitCode = 2;
  }
}

(async () => {
  if (process.argv.includes("--discover")) await runDiscover();
  const sw = arg("sweep");
  if (sw) await runSweep(Number(sw));
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
