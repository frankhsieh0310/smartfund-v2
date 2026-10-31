// Shared cloud-ingestion plumbing: run log + durable DB checkpoint.
//
// Storage (reused, no schema change):
//   - production_scheduler_runs          -> one row per cloud invocation (run log)
//   - production_scheduler_checkpoints   -> one row per rolling job (PK = checkpoint_key)
//
// No local files / PID / filesystem. Everything is Postgres via the shared Prisma client.

import { prisma } from "@/lib/prisma";

export type RunStatus = "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "SKIPPED";

// production_scheduler_runs.status is free text; map our vocabulary onto values already in use.
const STATUS_DB: Record<RunStatus, string> = {
  RUNNING: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
};

export type CheckpointRow = {
  lastSymbol: string | null;
  processed: number;
  succeeded: number;
  failed: number;
  updatedAt: string | null;
};

export type BeginRunInput = {
  jobName: string; // e.g. CLOUD_ETF_PRICE
  provider: string; // e.g. YAHOO_CHART
  runKey: string; // deterministic-enough per invocation; unique index dedups double triggers
  universeCount: number;
  batchSize: number;
  checkpointBefore: CheckpointRow | null;
};

export type FinishRunInput = {
  status: RunStatus;
  attempted: number;
  completed: number;
  inserted: number;
  updated: number;
  failed: number;
  retryableFailures: number;
  checkpointAfter: CheckpointRow | null;
  error?: string | null;
  details?: Record<string, unknown>;
};

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Optional, additive bound for callers that need a real DB-level guarantee (not just abandoning the
 * client-side promise): maxWait is how long Prisma may wait to ACQUIRE the transaction/connection slot
 * (the actual risk in practice — connection-pool contention); statementTimeoutMs becomes a Postgres
 * `SET LOCAL statement_timeout` issued as the transaction's first statement — this is what actually
 * cancels a hanging query server-side (verified against a real pg_sleep(30) hang: Prisma's own
 * `timeout` option alone never cancels an in-flight query, it only rejects the wrapper once the query
 * naturally finishes); timeoutMs is Prisma's own interactive-transaction `timeout`, the OUTER bound on
 * the whole transaction's wall-clock duration (acquiring the connection, running the query, COMMIT).
 *
 * timeoutMs MUST stay comfortably larger than statementTimeoutMs — confirmed in Production (run #1221,
 * 006203/006206) that setting them equal (both 20000ms) let the query legitimately run right up to its
 * own statement_timeout, and by the time Postgres cancelled it server-side, Prisma's transaction
 * wrapper had ALSO just expired (timeout=20000ms, actual elapsed≈20513–20537ms) — so the wrapper threw
 * "transaction already closed" instead of letting the (successful, un-hung) query commit. The headroom
 * between statementTimeoutMs and timeoutMs exists specifically so a query that finishes right at its
 * own statement_timeout still has time to COMMIT inside a transaction wrapper that hasn't expired yet.
 * Omit this param (every existing caller does) and behavior is 100% unchanged — plain
 * prisma.$queryRawUnsafe/$executeRawUnsafe, no new transaction wrapper. */
export type BoundedDbOptions = { maxWaitMs: number; timeoutMs: number; statementTimeoutMs: number };

async function boundedQuery<T>(sql: string, params: unknown[], bound?: BoundedDbOptions): Promise<T[]> {
  if (!bound) return prisma.$queryRawUnsafe<T[]>(sql, ...params);
  const statementTimeoutMs = Math.trunc(bound.statementTimeoutMs) | 0;
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      return tx.$queryRawUnsafe<T[]>(sql, ...params);
    },
    { maxWait: bound.maxWaitMs, timeout: bound.timeoutMs },
  );
}

async function boundedExecute(sql: string, params: unknown[], bound?: BoundedDbOptions): Promise<void> {
  if (!bound) { await prisma.$executeRawUnsafe(sql, ...params); return; }
  const statementTimeoutMs = Math.trunc(bound.statementTimeoutMs) | 0;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      await tx.$executeRawUnsafe(sql, ...params);
    },
    { maxWait: bound.maxWaitMs, timeout: bound.timeoutMs },
  );
}

// How long a RUNNING row is trusted as "someone is genuinely still working on this run_key" before
// it's treated as abandoned (a crashed/force-killed invocation that never reached finishRun, so the
// row is permanently stuck at RUNNING). Must sit comfortably ABOVE Vercel's own maxDuration=300s for
// this route (see route.ts) — by the time this TTL elapses, Vercel itself is GUARANTEED to have
// already force-killed any invocation that started that long ago, even one that somehow ran past its
// own HARD_RESPONSE_DEADLINE_MS=120000 soft deadline. 300s + 60s margin = 360s. Deliberately NOT sized
// off the 120s soft deadline alone — that would risk declaring a legitimately-still-running (if slow)
// invocation "stale" and letting a second caller steal it out from under it.
const STALE_RUNNING_TTL_SECONDS = 360;

/**
 * Insert the RUNNING run-log row. Returns { runId, skipped }.
 * skipped=true means a run with this run_key is CURRENTLY RUNNING AND FRESH — i.e. started less than
 * STALE_RUNNING_TTL_SECONDS ago, a genuine concurrent duplicate trigger — caller should no-op. Any
 * TERMINAL prior attempt (COMPLETED, PARTIAL, FAILED, SKIPPED) OR a STALE RUNNING row (started_at older
 * than the TTL — Vercel's own 300s maxDuration guarantees whatever invocation set it is long dead) does
 * NOT block a retry: the conflicting row is reused in place (fresh id, status=RUNNING, started_at=now,
 * completed_at/error cleared, attempted/completed/inserted/updated/failed reset to 0), so the exact
 * same batch can be re-attempted as a clean new attempt with no leftover terminal metadata from
 * whichever prior attempt owned the row.
 *
 * History: the guard was originally `status <> 'COMPLETED'` (any non-COMPLETED row, including RUNNING,
 * was reusable — so true concurrent duplicates were never reliably blocked). That was tightened to
 * `status <> 'RUNNING'` (any terminal status reusable, but ANY RUNNING row blocks, regardless of age) —
 * confirmed in Production (run #1231) to correctly unblock legitimate same-day retries at a previously-
 * COMPLETED run_key. But that tightened guard introduced a NEW failure mode (run #1233): a RUNNING row
 * left behind by an invocation that Vercel/curl force-killed before it ever reached finishRun (so
 * completed_at/status were never updated) is now a PERMANENT lock — every later legitimate retry at
 * that run_key sees status='RUNNING' and is skipped forever, exactly what happened to 7 of 17 issuers
 * (all retrying "...starting-at-0", 5 consecutive skips each). This round's fix: a RUNNING row only
 * blocks while it's FRESH (started_at within the TTL); once stale, it's treated the same as a terminal
 * row — reusable by a fresh attempt.
 */
export async function beginRun(input: BeginRunInput, bound?: BoundedDbOptions): Promise<{ runId: string; skipped: boolean }> {
  const runId = newId();
  const startedMs = Date.now();
  const details = {
    provider: input.provider,
    checkpoint_before: input.checkpointBefore,
    checkpoint_after: null,
    runtime_ms: 0,
    batch_size: input.batchSize,
    http_403: 0,
    http_429: 0,
    http_5xx: 0,
    fresh_skipped: 0,
    stale_skipped: 0,
    started_ms: startedMs,
  };
  // Atomic takeover: the WHERE guard on the ON CONFLICT...DO UPDATE is evaluated under Postgres's own
  // row-level lock for this run_key, so two concurrent callers can never both see "eligible" and both
  // win — exactly one UPDATE applies (or neither, if the existing row is RUNNING and fresh), with no
  // separate SELECT-then-UPDATE step that could race. staleTtlSeconds is an internal constant (never
  // user input), so direct interpolation into the SQL text here is safe — same pattern as the
  // SET LOCAL statement_timeout interpolation in boundedQuery/boundedExecute above.
  const rows = await boundedQuery<{ id: string }>(
    `INSERT INTO production_scheduler_runs
       (id, job_id, exchange, run_type, status, started_at, universe_count, run_key, details, attempted, completed, inserted, updated, failed)
     VALUES ($1, $2, 'CLOUD', 'CLOUD_INGESTION', $3, CURRENT_TIMESTAMP, $4, $5, $6::jsonb, 0, 0, 0, 0, 0)
     ON CONFLICT (run_key) WHERE run_key IS NOT NULL DO UPDATE SET
       id = EXCLUDED.id,
       status = EXCLUDED.status,
       started_at = CURRENT_TIMESTAMP,
       completed_at = NULL,
       universe_count = EXCLUDED.universe_count,
       details = EXCLUDED.details,
       attempted = 0, completed = 0, inserted = 0, updated = 0, failed = 0,
       error = NULL
     WHERE production_scheduler_runs.status <> $7
        OR production_scheduler_runs.started_at < (CURRENT_TIMESTAMP - INTERVAL '${STALE_RUNNING_TTL_SECONDS} seconds')
     RETURNING id`,
    [runId, input.jobName, STATUS_DB.RUNNING, input.universeCount, input.runKey, JSON.stringify(details), STATUS_DB.RUNNING],
    bound,
  );
  if (!rows.length) return { runId, skipped: true };
  return { runId: rows[0].id, skipped: false };
}

export async function finishRun(
  runId: string,
  jobName: string,
  provider: string,
  startedMs: number,
  input: FinishRunInput,
  bound?: BoundedDbOptions,
): Promise<void> {
  const details = {
    provider,
    checkpoint_before: input.details?.checkpoint_before ?? null,
    checkpoint_after: input.checkpointAfter,
    runtime_ms: Date.now() - startedMs,
    ...input.details,
  };
  await boundedExecute(
    `UPDATE production_scheduler_runs
       SET status = $2,
           completed_at = CURRENT_TIMESTAMP,
           attempted = $3,
           completed = $4,
           inserted = $5,
           updated = $6,
           failed = $7,
           retryable_failure_count = $8,
           error = $9,
           details = $10::jsonb
     WHERE id = $1`,
    [runId, STATUS_DB[input.status], input.attempted, input.completed, input.inserted, input.updated, input.failed, input.retryableFailures, input.error ?? null, JSON.stringify(details)],
    bound,
  );
  // best-effort marker so job_id is discoverable even though we store it in details
  void jobName;
}

// 2026-10-31（使用者核准，STALE_RUN_REAPED保底機制）: VERIFIED CLOUD_MONEYDJ_FUND過去7天有
// 291次IN_PROGRESS卡死（10/26當天96次執行全部卡死），根因是這支route用時間分桶的run_key
// （每15分鐘一個新桶），beginRun本身雖然已經有「同一個run_key超過STALE_RUNNING_TTL_SECONDS(6分鐘)
// 就允許下一次攻佔」的機制，但下一次呼叫根本是不同的run_key（新的時間桶），永遠不會真正去碰
// 那個卡住的舊row——卡住的row就這樣永久留著，不會被既有機制自動處理。改成在健康報告算異常之前
// 先主動掃一次「所有job、RUNNING超過指定分鐘數」，直接標成FAILED、error='STALE_RUN_REAPED'。
// 這是「每次執行都先掃一次」的做法裡最有效率的單點實作：因為時間分桶的run_key本來就不會被舊的
// 卡住row卡住下一次執行（不像同一個run_key重複使用的排程），真正需要處理的只有「健康報告看到
// 卡住的row誤判成異常」這件事，在健康報告自己要算異常之前掃一次已經足夠解決。
export async function reapStaleRunningRuns(maxAgeMinutes = 15, bound?: BoundedDbOptions): Promise<Array<{ id: string; jobId: string; runKey: string | null; startedAt: string }>> {
  const rows = await boundedQuery<{ id: string; job_id: string; run_key: string | null; started_at: string }>(
    `UPDATE production_scheduler_runs
       SET status = 'FAILED', completed_at = CURRENT_TIMESTAMP, error = 'STALE_RUN_REAPED'
     WHERE status = 'IN_PROGRESS'
       AND started_at < (CURRENT_TIMESTAMP - INTERVAL '${maxAgeMinutes} minutes')
     RETURNING id, job_id, run_key, started_at`,
    [],
    bound,
  );
  return rows.map((r) => ({ id: r.id, jobId: r.job_id, runKey: r.run_key, startedAt: r.started_at }));
}

export async function readCheckpoint(checkpointKey: string, bound?: BoundedDbOptions): Promise<CheckpointRow | null> {
  const rows = await boundedQuery<{ last_symbol: string | null; processed: number; succeeded: number; failed: number; updated_at: Date }>(
    `SELECT last_symbol, processed, succeeded, failed, updated_at
       FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`,
    [checkpointKey],
    bound,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    lastSymbol: row.last_symbol,
    processed: Number(row.processed ?? 0),
    succeeded: Number(row.succeeded ?? 0),
    failed: Number(row.failed ?? 0),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export async function writeCheckpoint(
  jobId: string,
  checkpointKey: string,
  runId: string,
  next: { lastSymbol: string | null; processed: number; succeeded: number; failed: number },
  bound?: BoundedDbOptions,
): Promise<void> {
  await boundedExecute(
    `INSERT INTO production_scheduler_checkpoints
       (checkpoint_key, job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at, run_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'ROLLING')
     ON CONFLICT (checkpoint_key) DO UPDATE
       SET job_id = EXCLUDED.job_id,
           run_id = EXCLUDED.run_id,
           last_symbol = EXCLUDED.last_symbol,
           processed = EXCLUDED.processed,
           succeeded = EXCLUDED.succeeded,
           failed = EXCLUDED.failed,
           updated_at = CURRENT_TIMESTAMP`,
    [checkpointKey, jobId, runId, next.lastSymbol, next.processed, next.succeeded, next.failed],
    bound,
  );
}

export function hourBucketKey(prefix: string, now = new Date()): string {
  return `${prefix}:${now.toISOString().slice(0, 13)}`; // e.g. cloud-etf-price:2026-09-09T11
}
