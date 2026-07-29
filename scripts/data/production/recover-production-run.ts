import { PrismaClient } from "@prisma/client";

const jobId = process.argv.find((value) => value.startsWith("--job="))?.slice(6);
const force = process.argv.includes("--force");
if (!jobId) throw new Error("Expected --job=<job-id>");

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const ageClause = force ? "" : " AND started_at < NOW() - INTERVAL '15 minutes'";
    const abandoned = await prisma.$executeRawUnsafe(
      `UPDATE production_scheduler_runs SET status = 'FAILED', completed_at = NOW(), exit_code = 1, error = 'ABANDONED_STALLED_RUN' WHERE job_id = $1 AND status = 'IN_PROGRESS'${ageClause}`,
      jobId,
    );
    const released = await prisma.$executeRawUnsafe(
      "DELETE FROM production_scheduler_locks WHERE job_id = $1 AND NOT EXISTS (SELECT 1 FROM production_scheduler_runs WHERE job_id = $1 AND status = 'IN_PROGRESS')",
      jobId,
    );
    console.log(JSON.stringify({ jobId, force, abandoned, released }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
