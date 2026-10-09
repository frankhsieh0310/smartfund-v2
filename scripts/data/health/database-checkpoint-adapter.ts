import type { PrismaClient } from "@prisma/client";

export type DatabaseOwnership = { supported: boolean; ownerActive: boolean; ambiguous: boolean; checkpointExists: boolean; pending: number; retryCount: number; cursor: string | null; heartbeatAt: Date | null; lastSuccessAt: Date | null; nextRunAt: Date | null; details: Record<string, unknown> };
export function classifyOwnership(activeOwners: number): Pick<DatabaseOwnership, "ownerActive" | "ambiguous"> { return { ownerActive: activeOwners === 1, ambiguous: activeOwners > 1 }; }

export async function readDatabaseOwnership(prisma: PrismaClient, reference: string | null | undefined): Promise<DatabaseOwnership> {
  const unsupported = { supported: false, ownerActive: false, ambiguous: false, checkpointExists: false, pending: 0, retryCount: 0, cursor: null, heartbeatAt: null, lastSuccessAt: null, nextRunAt: null, details: {} };
  if (!reference?.startsWith("DATABASE:")) return unsupported;
  const [, table, identity] = reference.split(":");
  if (table === "production_scheduler_checkpoints" && identity) {
    const checkpoints = await prisma.$queryRawUnsafe<any[]>(`SELECT c.job_id,c.last_symbol,c.processed,c.succeeded,c.failed,c.updated_at,r.completed_at,r.status FROM production_scheduler_checkpoints c LEFT JOIN production_scheduler_runs r ON r.id=c.run_id WHERE c.job_id=$1 ORDER BY c.updated_at DESC LIMIT 1`, identity);
    const locks = await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int count FROM production_scheduler_locks WHERE job_id=$1 AND expires_at>NOW() AND updated_at>NOW()-INTERVAL '10 minutes'`, identity);
    const row = checkpoints[0], activeOwners = Number(locks[0]?.count ?? 0), owner = classifyOwnership(activeOwners);
    return { supported: true, ...owner, checkpointExists: Boolean(row), pending: Math.max(0, Number(row?.failed ?? 0)), retryCount: Number(row?.failed ?? 0), cursor: row?.last_symbol ?? null, heartbeatAt: row?.updated_at ?? null, lastSuccessAt: row?.status === "COMPLETED" ? row?.completed_at ?? row?.updated_at : null, nextRunAt: null, details: { jobId: identity, runStatus: row?.status ?? null, activeOwners } };
  }
  if (table === "crypto_work_items") {
    const rows = await prisma.$queryRawUnsafe<any[]>(`SELECT count(*) FILTER(WHERE status='RUNNING')::int active,count(*) FILTER(WHERE status IN ('PENDING','RETRY') AND (next_run_at IS NULL OR next_run_at<=NOW()))::int pending,max(updated_at) updated_at,max(completed_at) completed_at,sum(attempts)::int retries FROM crypto_work_items`);
    const row = rows[0] ?? {}, owner = classifyOwnership(Number(row.active ?? 0));
    return { supported: true, ...owner, checkpointExists: true, pending: Number(row.pending ?? 0), retryCount: Number(row.retries ?? 0), cursor: null, heartbeatAt: row.updated_at ?? null, lastSuccessAt: row.completed_at ?? null, nextRunAt: null, details: { activeOwners: Number(row.active ?? 0), queue: "crypto_work_items" } };
  }
  return unsupported;
}
