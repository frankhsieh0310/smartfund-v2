import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

export type RunSummary = {
  attempted: number;
  completed: number;
  inserted: number;
  updated: number;
  failed: number;
  success: number;
  noUpdate: number;
  permanentUnavailable: number;
  retryableFailure: number;
  upToProviderLatest: number;
};

export type ResumeCheckpoint = {
  last_symbol: string | null;
  processed: number;
  succeeded: number;
  failed: number;
  details: Partial<RunSummary> | null;
};

export type LifecycleRunContext = {
  targetTradeDate?: Date;
  expectedTradingDate?: Date;
  providerLatestDate?: Date;
  runKey?: string;
  universeCount?: number;
};

export type LifecycleCheckpointContext = {
  jobId: string;
  targetTradeDate?: Date;
  runType: string;
};

function resumeSummary(value: unknown): Partial<RunSummary> | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const fields = ["attempted", "completed", "inserted", "updated", "failed", "success", "noUpdate", "permanentUnavailable", "retryableFailure", "upToProviderLatest"] as const;
  const result: Partial<RunSummary> = {};
  for (const field of fields) {
    const candidate = (parsed as Record<string, unknown>)[field];
    if (typeof candidate === "number" && Number.isFinite(candidate)) result[field] = candidate;
  }
  return result;
}

export function createSummary(): RunSummary {
  return { attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, success: 0, noUpdate: 0, permanentUnavailable: 0, retryableFailure: 0, upToProviderLatest: 0 };
}

export function addOutcome(summary: RunSummary, outcome: Partial<RunSummary>): void {
  for (const key of Object.keys(summary) as Array<keyof RunSummary>) summary[key] += outcome[key] ?? 0;
}

/**
 * A Railway cron process can be killed after acquiring its lock but before its
 * first checkpoint. Treat an untouched lock as stale after a bounded window;
 * this is intentionally much shorter than the previous eight-hour lease so a
 * subsequent cron can resume from the durable checkpoint.
 */
export async function recoverOrphanedLifecycleRun(prisma: PrismaClient, jobId: string): Promise<number> {
  return prisma.$executeRawUnsafe(
    "UPDATE production_scheduler_runs SET status = 'STALE', completed_at = NOW(), exit_code = 1, error = COALESCE(error, 'ORPHANED_LOCK_RECOVERY') WHERE job_id = $1 AND status = 'IN_PROGRESS' AND started_at < NOW() - INTERVAL '10 minutes'",
    jobId,
  );
}

export async function acquireLifecycleLock(prisma: PrismaClient, jobId: string, owner: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ job_id: string }[]>(
    "INSERT INTO production_scheduler_locks (job_id, owner, expires_at, updated_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes', NOW()) ON CONFLICT (job_id) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at, updated_at = NOW() WHERE production_scheduler_locks.expires_at < NOW() OR production_scheduler_locks.updated_at < NOW() - INTERVAL '10 minutes' RETURNING job_id",
    jobId,
    owner,
  );
  return rows.length === 1;
}

export async function releaseLifecycleLock(prisma: PrismaClient, jobId: string, owner: string): Promise<void> {
  await prisma.$executeRawUnsafe("DELETE FROM production_scheduler_locks WHERE job_id = $1 AND owner = $2", jobId, owner);
}

export async function heartbeatLifecycleLock(prisma: PrismaClient, jobId: string, owner: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    "UPDATE production_scheduler_locks SET expires_at = NOW() + INTERVAL '10 minutes', updated_at = NOW() WHERE job_id = $1 AND owner = $2",
    jobId,
    owner,
  );
}

export async function createLifecycleRun(
  prisma: PrismaClient,
  jobId: string,
  exchange: string,
  runType: string,
  context: LifecycleRunContext = {},
): Promise<string> {
  const runId = randomUUID();
  const inserted = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    "INSERT INTO production_scheduler_runs (id, job_id, exchange, run_type, status, target_trade_date, expected_trading_date, provider_latest_date, run_key, universe_count) VALUES ($1, $2, $3, $4, 'IN_PROGRESS', $5, $6, $7, $8, $9) ON CONFLICT (run_key) WHERE run_key IS NOT NULL DO NOTHING RETURNING id",
    runId,
    jobId,
    exchange,
    runType,
    context.targetTradeDate ?? null,
    context.expectedTradingDate ?? null,
    context.providerLatestDate ?? null,
    context.runKey ?? null,
    context.universeCount ?? 0,
  );
  if (inserted[0]) return inserted[0].id;
  if (!context.runKey) throw new Error(`LIFECYCLE_RUN_INSERT_FAILED:${jobId}`);
  const existing = await prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
    "SELECT id, status FROM production_scheduler_runs WHERE run_key = $1 LIMIT 1",
    context.runKey,
  );
  if (!existing[0]) throw new Error(`LIFECYCLE_RUN_KEY_NOT_FOUND:${context.runKey}`);
  if (existing[0].status === "COMPLETED") return existing[0].id;
  await prisma.$executeRawUnsafe(
    "UPDATE production_scheduler_runs SET status = 'IN_PROGRESS', completed_at = NULL, exit_code = NULL, error = NULL, provider_latest_date = COALESCE($2, provider_latest_date), universe_count = GREATEST(universe_count, $3) WHERE id = $1",
    existing[0].id,
    context.providerLatestDate ?? null,
    context.universeCount ?? 0,
  );
  return existing[0].id;
}

export async function persistLifecycleCheckpoint(
  prisma: PrismaClient,
  runId: string,
  summary: RunSummary,
  currentSymbol: string,
  context?: LifecycleCheckpointContext,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    "UPDATE production_scheduler_runs SET attempted = $2, completed = $3, inserted = $4, updated = $5, failed = $6, details = $7::jsonb WHERE id = $1",
    runId,
    summary.attempted,
    summary.completed,
    summary.inserted,
    summary.updated,
    summary.failed,
    JSON.stringify({ ...summary, currentSymbol, checkpointAt: new Date().toISOString() }),
  );
  const rows = context ? [{ job_id: context.jobId, run_type: context.runType }] : await prisma.$queryRawUnsafe<Array<{ job_id: string; run_type: string }>>(
    "SELECT job_id, run_type FROM production_scheduler_runs WHERE id = $1",
    runId,
  );
  if (!rows[0]) throw new Error(`LIFECYCLE_RUN_NOT_FOUND:${runId}`);
  const targetKey = context?.targetTradeDate?.toISOString().slice(0, 10) ?? "LEGACY";
  const checkpointKey = `${rows[0].job_id}:${targetKey}:${rows[0].run_type}`;
  await prisma.$executeRawUnsafe(
    "INSERT INTO production_scheduler_checkpoints (checkpoint_key, job_id, run_id, last_symbol, processed, succeeded, failed, target_trade_date, run_type, started_at, updated_at) SELECT $2, job_id, id, $3, $4, $5, $6, $7, $8, started_at, NOW() FROM production_scheduler_runs WHERE id = $1 ON CONFLICT (checkpoint_key) DO UPDATE SET run_id = EXCLUDED.run_id, last_symbol = EXCLUDED.last_symbol, processed = EXCLUDED.processed, succeeded = EXCLUDED.succeeded, failed = EXCLUDED.failed, target_trade_date = EXCLUDED.target_trade_date, run_type = EXCLUDED.run_type, updated_at = NOW()",
    runId,
    checkpointKey,
    currentSymbol,
    summary.attempted,
    summary.completed,
    summary.failed,
    context?.targetTradeDate ?? null,
    rows[0].run_type,
  );
}

export async function loadLifecycleResumeCheckpoint(
  prisma: PrismaClient,
  jobId: string,
  context?: { targetTradeDate: Date; runType: string },
): Promise<ResumeCheckpoint | null> {
  const rows = await prisma.$queryRawUnsafe<Array<Omit<ResumeCheckpoint, "details"> & { details: unknown }>>(
    // An orphaned run is intentionally marked STALE before its lock is
    // released. Its checkpoint is still the authoritative continuation point.
    context
      ? "SELECT c.last_symbol, c.processed, c.succeeded, c.failed, r.details FROM production_scheduler_checkpoints c JOIN production_scheduler_runs r ON r.id = c.run_id WHERE c.job_id = $1 AND c.target_trade_date = $2 AND c.run_type = $3 AND r.status IN ('IN_PROGRESS', 'PAUSED', 'ABANDONED', 'STALE', 'FAILED') ORDER BY c.updated_at DESC LIMIT 1"
      : "SELECT c.last_symbol, c.processed, c.succeeded, c.failed, r.details FROM production_scheduler_checkpoints c JOIN production_scheduler_runs r ON r.id = c.run_id WHERE c.job_id = $1 AND r.status IN ('IN_PROGRESS', 'PAUSED', 'ABANDONED', 'STALE', 'FAILED') ORDER BY c.updated_at DESC LIMIT 1",
    jobId,
    ...(context ? [context.targetTradeDate, context.runType] : []),
  );
  const row = rows[0];
  return row ? { ...row, details: resumeSummary(row.details) } : null;
}

export async function completeLifecycleRun(prisma: PrismaClient, runId: string, summary: RunSummary, latestTradingDate: Date | null, validation: Record<string, unknown>): Promise<void> {
  const status = validation.status === "PASS" ? "COMPLETED" : "FAILED";
  await prisma.$executeRawUnsafe(
    "UPDATE production_scheduler_runs SET status = $2, completed_at = NOW(), attempted = $3, completed = $4, inserted = $5, updated = $6, failed = $7, success_count = $8, no_update_count = $9, permanent_unavailable_count = $10, retryable_failure_count = $11, latest_trading_date = $12, validation_status = $13, validation_details = $14::jsonb, exit_code = CASE WHEN $2 = 'COMPLETED' THEN 0 ELSE 1 END, details = $15::jsonb WHERE id = $1",
    runId,
    status,
    summary.attempted,
    summary.completed,
    summary.inserted,
    summary.updated,
    summary.failed,
    summary.success,
    summary.noUpdate,
    summary.permanentUnavailable,
    summary.retryableFailure,
    latestTradingDate,
    validation.status,
    JSON.stringify(validation),
    JSON.stringify({ ...summary, summaryType: "PRODUCTION_RUN" }),
  );
}

export async function failLifecycleRun(prisma: PrismaClient, runId: string, error: unknown): Promise<void> {
  await prisma.$executeRawUnsafe(
    "UPDATE production_scheduler_runs SET status = 'FAILED', completed_at = NOW(), exit_code = 1, error = $2 WHERE id = $1",
    runId,
    error instanceof Error ? error.message : String(error),
  ).catch(() => undefined);
}

export async function pauseLifecycleRun(prisma: PrismaClient, runId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    "UPDATE production_scheduler_runs SET status = 'PAUSED', completed_at = NOW(), exit_code = 0 WHERE id = $1",
    runId,
  );
}
