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

/**
 * Insert the RUNNING run-log row. Returns { runId, skipped }.
 * skipped=true means a run with this run_key already COMPLETED — caller should no-op. A prior
 * attempt that FAILED, was PARTIAL, or never got past RUNNING (crashed before finishRun) does NOT
 * block a retry: the conflicting row is reused in place (same run_key, fresh id/status/started_at),
 * so the exact same batch can be re-attempted. Once a run_key's row reaches COMPLETED, no later
 * attempt can overwrite it — that single `status <> 'COMPLETED'` guard is what still prevents two
 * genuinely-successful runs from ever being recorded for the same run_key.
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
     RETURNING id`,
    [runId, input.jobName, STATUS_DB.RUNNING, input.universeCount, input.runKey, JSON.stringify(details), STATUS_DB.COMPLETED],
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
