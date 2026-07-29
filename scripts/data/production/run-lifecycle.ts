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
};

export type ResumeCheckpoint = {
  last_symbol: string | null;
  processed: number;
  succeeded: number;
  failed: number;
};

export function createSummary(): RunSummary {
  return { attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, success: 0, noUpdate: 0, permanentUnavailable: 0, retryableFailure: 0 };
}

export function addOutcome(summary: RunSummary, outcome: Partial<RunSummary>): void {
  for (const key of Object.keys(summary) as Array<keyof RunSummary>) summary[key] += outcome[key] ?? 0;
}

export async function acquireLifecycleLock(prisma: PrismaClient, jobId: string, owner: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ job_id: string }[]>(
    "INSERT INTO production_scheduler_locks (job_id, owner, expires_at, updated_at) VALUES ($1, $2, NOW() + INTERVAL '8 hours', NOW()) ON CONFLICT (job_id) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at, updated_at = NOW() WHERE production_scheduler_locks.expires_at < NOW() RETURNING job_id",
    jobId,
    owner,
  );
  return rows.length === 1;
}

export async function releaseLifecycleLock(prisma: PrismaClient, jobId: string, owner: string): Promise<void> {
  await prisma.$executeRawUnsafe("DELETE FROM production_scheduler_locks WHERE job_id = $1 AND owner = $2", jobId, owner);
}

export async function createLifecycleRun(prisma: PrismaClient, jobId: string, exchange: string, runType: string): Promise<string> {
  const runId = randomUUID();
  await prisma.$executeRawUnsafe(
    "INSERT INTO production_scheduler_runs (id, job_id, exchange, run_type, status) VALUES ($1, $2, $3, $4, 'IN_PROGRESS')",
    runId,
    jobId,
    exchange,
    runType,
  );
  return runId;
}

export async function persistLifecycleCheckpoint(prisma: PrismaClient, runId: string, summary: RunSummary, currentSymbol: string): Promise<void> {
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
  await prisma.$executeRawUnsafe(
    "INSERT INTO production_scheduler_checkpoints (job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at) SELECT job_id, id, $2, $3, $4, $5, started_at, NOW() FROM production_scheduler_runs WHERE id = $1 ON CONFLICT (job_id) DO UPDATE SET run_id = EXCLUDED.run_id, last_symbol = EXCLUDED.last_symbol, processed = EXCLUDED.processed, succeeded = EXCLUDED.succeeded, failed = EXCLUDED.failed, updated_at = NOW()",
    runId,
    currentSymbol,
    summary.attempted,
    summary.completed,
    summary.failed,
  );
}

export async function loadLifecycleResumeCheckpoint(prisma: PrismaClient, jobId: string): Promise<ResumeCheckpoint | null> {
  const rows = await prisma.$queryRawUnsafe<ResumeCheckpoint[]>(
    "SELECT c.last_symbol, c.processed, c.succeeded, c.failed FROM production_scheduler_checkpoints c JOIN production_scheduler_runs r ON r.id = c.run_id WHERE c.job_id = $1 AND r.status <> 'COMPLETED' ORDER BY c.updated_at DESC LIMIT 1",
    jobId,
  );
  return rows[0] ?? null;
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
