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

/**
 * Insert the RUNNING run-log row. Returns { runId, skipped }.
 * skipped=true means a row with this run_key already exists (double trigger) — caller should no-op.
 */
export async function beginRun(input: BeginRunInput): Promise<{ runId: string; skipped: boolean }> {
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
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO production_scheduler_runs
       (id, job_id, exchange, run_type, status, started_at, universe_count, run_key, details, attempted, completed, inserted, updated, failed)
     VALUES ($1, $2, 'CLOUD', 'CLOUD_INGESTION', $3, CURRENT_TIMESTAMP, $4, $5, $6::jsonb, 0, 0, 0, 0, 0)
     ON CONFLICT (run_key) WHERE run_key IS NOT NULL DO NOTHING
     RETURNING id`,
    runId,
    input.jobName,
    STATUS_DB.RUNNING,
    input.universeCount,
    input.runKey,
    JSON.stringify(details),
  );
  if (!rows.length) return { runId, skipped: true };
  return { runId, skipped: false };
}

export async function finishRun(
  runId: string,
  jobName: string,
  provider: string,
  startedMs: number,
  input: FinishRunInput,
): Promise<void> {
  const details = {
    provider,
    checkpoint_before: input.details?.checkpoint_before ?? null,
    checkpoint_after: input.checkpointAfter,
    runtime_ms: Date.now() - startedMs,
    ...input.details,
  };
  await prisma.$executeRawUnsafe(
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
    runId,
    STATUS_DB[input.status],
    input.attempted,
    input.completed,
    input.inserted,
    input.updated,
    input.failed,
    input.retryableFailures,
    input.error ?? null,
    JSON.stringify(details),
  );
  // best-effort marker so job_id is discoverable even though we store it in details
  void jobName;
}

export async function readCheckpoint(checkpointKey: string): Promise<CheckpointRow | null> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ last_symbol: string | null; processed: number; succeeded: number; failed: number; updated_at: Date }>
  >(
    `SELECT last_symbol, processed, succeeded, failed, updated_at
       FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`,
    checkpointKey,
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
): Promise<void> {
  await prisma.$executeRawUnsafe(
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
    checkpointKey,
    jobId,
    runId,
    next.lastSymbol,
    next.processed,
    next.succeeded,
    next.failed,
  );
}

export function hourBucketKey(prefix: string, now = new Date()): string {
  return `${prefix}:${now.toISOString().slice(0, 13)}`; // e.g. cloud-etf-price:2026-09-09T11
}
