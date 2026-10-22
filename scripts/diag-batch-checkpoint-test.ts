// Focused test of the bounded-batch + checkpoint algorithm used by
// app/api/cron/etf-official-holdings/route.ts — same shared plumbing (lib/cloud-ingestion/runContext.ts,
// lib/etf-holdings-engine/storage.ts upsertSnapshot), but against 95 FAKE items and a TEST-ONLY
// checkpoint key ("etf-official-holdings-TEST"), never the real "etf-official-holdings" key and never
// a real ETF fetch. The test checkpoint row is deleted at the end.
// NOTE: lib/cloud-ingestion/runContext.ts imports "@/lib/prisma" (a Next.js path alias), which only
// resolves inside Next's own build/runtime — not in a standalone `node --experimental-strip-types`
// script. So this test issues the IDENTICAL SQL that runContext.ts's beginRun/finishRun/readCheckpoint/
// writeCheckpoint use, directly via `pg`, against the same tables — it is not a different mechanism,
// just the same mechanism invoked without the Next.js module resolver.
import { Client } from "pg";
import { upsertSnapshot } from "../lib/etf-holdings-engine/storage.ts";
import type { CanonicalSnapshot } from "../lib/etf-holdings-engine/types.ts";

type CheckpointRow = { lastSymbol: string | null; processed: number; succeeded: number; failed: number; updatedAt: string | null };

async function readCheckpoint(client: Client, checkpointKey: string): Promise<CheckpointRow | null> {
  const { rows } = await client.query(
    `SELECT last_symbol, processed, succeeded, failed, updated_at FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`,
    [checkpointKey],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    lastSymbol: row.last_symbol, processed: Number(row.processed ?? 0), succeeded: Number(row.succeeded ?? 0),
    failed: Number(row.failed ?? 0), updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}
async function writeCheckpoint(client: Client, jobId: string, checkpointKey: string, runId: string, next: { lastSymbol: string | null; processed: number; succeeded: number; failed: number }) {
  await client.query(
    `INSERT INTO production_scheduler_checkpoints (checkpoint_key, job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at, run_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'ROLLING')
     ON CONFLICT (checkpoint_key) DO UPDATE SET job_id=EXCLUDED.job_id, run_id=EXCLUDED.run_id, last_symbol=EXCLUDED.last_symbol, processed=EXCLUDED.processed, succeeded=EXCLUDED.succeeded, failed=EXCLUDED.failed, updated_at=CURRENT_TIMESTAMP`,
    [checkpointKey, jobId, runId, next.lastSymbol, next.processed, next.succeeded, next.failed],
  );
}
function newId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
async function beginRun(client: Client, jobName: string, runKey: string, universeCount: number, batchSize: number): Promise<{ runId: string }> {
  const runId = newId();
  await client.query(
    `INSERT INTO production_scheduler_runs (id, job_id, exchange, run_type, status, started_at, universe_count, run_key, details, attempted, completed, inserted, updated, failed)
     VALUES ($1, $2, 'CLOUD', 'CLOUD_INGESTION', 'IN_PROGRESS', CURRENT_TIMESTAMP, $3, $4, $5::jsonb, 0, 0, 0, 0, 0)
     ON CONFLICT (run_key) WHERE run_key IS NOT NULL DO NOTHING`,
    [runId, jobName, universeCount, runKey, JSON.stringify({ batch_size: batchSize })],
  );
  return { runId };
}
async function finishRun(client: Client, runId: string, status: string, attempted: number, completed: number, failed: number) {
  await client.query(
    `UPDATE production_scheduler_runs SET status=$2, completed_at=CURRENT_TIMESTAMP, attempted=$3, completed=$4, inserted=$4, updated=0, failed=$5 WHERE id=$1`,
    [runId, status, attempted, completed, failed],
  );
}

const TEST_KEY = "etf-official-holdings-TEST";
const JOB = "ETF_OFFICIAL_HOLDINGS_TEST";
const BATCH_SIZE = 40;

const FAKE_ITEMS = Array.from({ length: 95 }, (_, i) => `FAKE${String(i).padStart(3, "0")}`);
// Item at index 50 always fails (even after the one bounded retry) — isolation check.
const ALWAYS_FAIL_TICKER = FAKE_ITEMS[50];

function taipeiDateKey(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function todayTaipeiKey(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function fakeFetch(ticker: string): Promise<CanonicalSnapshot> {
  if (ticker === ALWAYS_FAIL_TICKER) throw new Error("FAKE_TRANSIENT_FAILURE");
  return {
    etfCode: `TESTFN2_${ticker}`, issuer: "TEST", assetType: "EQUITY",
    dataDate: "2026-09-24", announcementDate: "2026-09-24",
    fundNav: 1000, outstandingUnits: 100,
    positions: [{ securityCode: "S1", securityName: "Stock1", positionType: "EQUITY", positionAmount: 1000, positionUnit: "SHARES", weight: 10, canonicalSecurityId: null }],
    source: "TEST", retrievedAt: new Date().toISOString(),
  };
}

async function runOneInvocation(pgClient: Client, dayOverrideKey?: string) {
  const query = async (sql: string, params: unknown[]) => (await pgClient.query(sql, params)).rows;

  const stored = await readCheckpoint(pgClient, TEST_KEY);
  const isFromToday = dayOverrideKey
    ? taipeiDateKey(stored?.updatedAt ?? null) === dayOverrideKey
    : taipeiDateKey(stored?.updatedAt ?? null) === todayTaipeiKey();
  const effective: CheckpointRow | null = isFromToday ? stored : null;

  const startIndex = effective?.lastSymbol ? FAKE_ITEMS.indexOf(effective.lastSymbol) + 1 : 0;
  const batch = FAKE_ITEMS.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + BATCH_SIZE);
  const reachedEndCandidate = Math.max(startIndex, 0) + batch.length >= FAKE_ITEMS.length;

  const runKey = `${JOB}:${dayOverrideKey ?? todayTaipeiKey()}:batch-at-${Math.max(startIndex, 0)}:${Date.now()}:${Math.random()}`;
  const { runId } = await beginRun(pgClient, JOB, runKey, FAKE_ITEMS.length, BATCH_SIZE);

  let processed = 0, passed = 0, failed = 0;
  const failedTickers: string[] = [];
  let lastProcessed: string | null = effective?.lastSymbol ?? null;

  for (const ticker of batch) {
    processed++;
    lastProcessed = ticker;
    try {
      let snap: CanonicalSnapshot;
      try {
        snap = await fakeFetch(ticker);
      } catch {
        await new Promise((r) => setTimeout(r, 5)); // bounded retry (shortened for the test)
        snap = await fakeFetch(ticker);
      }
      await upsertSnapshot(query, snap);
      passed++;
    } catch {
      failed++;
      failedTickers.push(ticker);
    }
  }

  const reachedEnd = reachedEndCandidate;
  const nextCursor = reachedEnd ? null : lastProcessed;
  await writeCheckpoint(pgClient, JOB, TEST_KEY, runId, {
    lastSymbol: nextCursor,
    processed: (isFromToday ? effective?.processed ?? 0 : 0) + processed,
    succeeded: (isFromToday ? effective?.succeeded ?? 0 : 0) + passed,
    failed: (isFromToday ? effective?.failed ?? 0 : 0) + failed,
  });
  await finishRun(pgClient, runId, failed > 0 ? "PARTIAL" : "COMPLETED", processed, passed, failed);

  return { processed, passed, failed, failedTickers, reachedEnd, batchStartIndex: Math.max(startIndex, 0), batchLength: batch.length };
}

async function main() {
  const pgClient = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await pgClient.connect();
  const results: Record<string, unknown> = {};

  await pgClient.query(`DELETE FROM production_scheduler_checkpoints WHERE checkpoint_key = $1`, [TEST_KEY]);
  await pgClient.query(`DELETE FROM etf_official_daily_snapshots WHERE etf_code LIKE 'TESTFN2_%'`);

  // --- checkpoint continuation + failure isolation across batch1(40)/batch2(40)/batch3(15) ---
  await pgClient.query("BEGIN");
  try {
    const b1 = await runOneInvocation(pgClient);
    const b2 = await runOneInvocation(pgClient);
    const b3 = await runOneInvocation(pgClient);

    results.TEST_95_BATCHES = {
      batch1: { start: b1.batchStartIndex, length: b1.batchLength, reachedEnd: b1.reachedEnd },
      batch2: { start: b2.batchStartIndex, length: b2.batchLength, reachedEnd: b2.reachedEnd },
      batch3: { start: b3.batchStartIndex, length: b3.batchLength, reachedEnd: b3.reachedEnd },
    };
    results.CHECKPOINT_CONTINUATION =
      b1.batchStartIndex === 0 && b1.batchLength === 40 && !b1.reachedEnd &&
      b2.batchStartIndex === 40 && b2.batchLength === 40 && !b2.reachedEnd &&
      b3.batchStartIndex === 80 && b3.batchLength === 15 && b3.reachedEnd
        ? "PASS" : "FAIL";
    results.REACHED_END_TEST = b3.reachedEnd === true && !b1.reachedEnd && !b2.reachedEnd ? "PASS" : "FAIL";

    // FAKE050 falls in batch2 (index 40-79) — confirm it failed but batch2 still processed all 40 and
    // the checkpoint still advanced past it (isolation).
    const failedInB2 = b2.failedTickers.includes(ALWAYS_FAIL_TICKER);
    results.FAILURE_ISOLATION =
      failedInB2 && b2.failed === 1 && b2.passed === 39 && b2.processed === 40 && b3.batchStartIndex === 80
        ? "PASS" : `FAIL (${JSON.stringify({ failedInB2, b2Failed: b2.failed, b2Passed: b2.passed, b3Start: b3.batchStartIndex })})`;

    // Idempotency: re-run the same fake item's upsert twice for the same dataDate, confirm no duplicate row.
    const dupQuery = async (sql: string, params: unknown[]) => (await pgClient.query(sql, params)).rows;
    const dupSnap: CanonicalSnapshot = {
      etfCode: "TESTFN2_IDEMPOTENT", issuer: "TEST", assetType: "EQUITY", dataDate: "2026-09-24",
      announcementDate: "2026-09-24", fundNav: 1000, outstandingUnits: 100,
      positions: [{ securityCode: "S1", securityName: "Stock1", positionType: "EQUITY", positionAmount: 1000, positionUnit: "SHARES", weight: 10, canonicalSecurityId: null }],
      source: "TEST", retrievedAt: new Date().toISOString(),
    };
    await upsertSnapshot(dupQuery, dupSnap);
    await upsertSnapshot(dupQuery, { ...dupSnap, fundNav: 2000 }); // same (etf_code, data_date), different value
    const dupCount = await pgClient.query(`SELECT COUNT(*) c FROM etf_official_daily_snapshots WHERE etf_code = 'TESTFN2_IDEMPOTENT'`);
    results.IDEMPOTENT = dupCount.rows[0].c === "1" ? "PASS" : `FAIL (${dupCount.rows[0].c} rows)`;
  } finally {
    await pgClient.query("ROLLBACK");
  }

  // --- next-day reset (separate from the rollback block above: writes+backdates a real checkpoint row
  // under the TEST key, then deletes it — never touches the real "etf-official-holdings" key) ---
  await pgClient.query(`DELETE FROM production_scheduler_checkpoints WHERE checkpoint_key = $1`, [TEST_KEY]);
  const { runId: seedRunId } = await beginRun(pgClient, JOB, `${JOB}:seed:${Date.now()}`, FAKE_ITEMS.length, BATCH_SIZE);
  await writeCheckpoint(pgClient, JOB, TEST_KEY, seedRunId, { lastSymbol: FAKE_ITEMS[94], processed: 95, succeeded: 95, failed: 0 });
  // backdate to "yesterday" so the day-check must treat it as stale and reset
  await pgClient.query(
    `UPDATE production_scheduler_checkpoints SET updated_at = updated_at - interval '1 day' WHERE checkpoint_key = $1`,
    [TEST_KEY],
  );
  const afterYesterdayCompletion = await runOneInvocation(pgClient); // "today" per real clock — should reset
  results.NEXT_DAY_RESET =
    afterYesterdayCompletion.batchStartIndex === 0 && afterYesterdayCompletion.batchLength === 40
      ? "PASS" : `FAIL (${JSON.stringify(afterYesterdayCompletion)})`;

  await pgClient.query(`DELETE FROM production_scheduler_checkpoints WHERE checkpoint_key = $1`, [TEST_KEY]);
  await pgClient.query(`DELETE FROM etf_official_daily_snapshots WHERE etf_code LIKE 'TESTFN2_%'`);

  const finalSnapCount = await pgClient.query(`SELECT COUNT(*) c FROM etf_official_daily_snapshots WHERE etf_code LIKE 'TESTFN2_%'`);
  const finalCheckpointCount = await pgClient.query(`SELECT COUNT(*) c FROM production_scheduler_checkpoints WHERE checkpoint_key = $1`, [TEST_KEY]);
  results.CLEANUP_CONFIRMED = finalSnapCount.rows[0].c === "0" && finalCheckpointCount.rows[0].c === "0";

  await pgClient.end();
  console.log(JSON.stringify(results, null, 2));
}
main().catch((e) => { console.error("TEST_FAILED:", e); process.exit(1); });
