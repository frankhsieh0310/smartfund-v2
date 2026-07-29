import { PrismaClient } from "@prisma/client";

const jobId = process.argv.find((value) => value.startsWith("--job="))?.slice(6);
if (!jobId) throw new Error("Expected --job=<job-id>");

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const abandonedRuns = await prisma.$executeRawUnsafe(
      "UPDATE production_scheduler_runs SET status = 'FAILED', completed_at = NOW(), error = 'ABANDONED_STALLED_RUN' WHERE job_id = $1 AND status = 'IN_PROGRESS' AND started_at < NOW() - INTERVAL '15 minutes'",
      jobId,
    );
    const expiredLocks = await prisma.$executeRawUnsafe(
      "DELETE FROM production_scheduler_locks WHERE job_id = $1 AND NOT EXISTS (SELECT 1 FROM production_scheduler_runs WHERE job_id = $1 AND status = 'IN_PROGRESS')",
      jobId,
    );
    console.log(JSON.stringify({ jobId, abandonedRuns, expiredLocks }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
