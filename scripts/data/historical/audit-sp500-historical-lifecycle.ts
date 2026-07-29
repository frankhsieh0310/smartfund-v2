import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const market = process.argv.find((value) => value.startsWith("--market="))?.slice("--market=".length) ?? "SP500";
const jobId = market === "NYSE" ? "nyse-yahoo-historical" : "sp500-yahoo-historical";

async function main(): Promise<void> {
  try {
    const [runs, checkpoints, locks, failures, universe] = await Promise.all([
      prisma.$queryRawUnsafe("SELECT id, status, started_at, completed_at, exit_code, attempted, completed, failed, details FROM production_scheduler_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 5", jobId),
      prisma.$queryRawUnsafe("SELECT job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at FROM production_scheduler_checkpoints WHERE job_id = $1", jobId),
      prisma.$queryRawUnsafe("SELECT job_id, owner, created_at, updated_at, expires_at FROM production_scheduler_locks WHERE job_id = $1", jobId),
      prisma.$queryRawUnsafe("SELECT symbol, attempts, error_type, classification, resolved, last_error, last_attempted_at, next_retry_at FROM production_scheduler_failures WHERE job_id = $1 ORDER BY symbol", jobId),
      market === "NYSE" ? prisma.stock.count({ where: { country: "US", exchange: "NYSE", isActive: true, yahooSymbol: { not: "" } } }) : Promise.resolve(504),
    ]);
    console.log(JSON.stringify({ market, universe, runs, checkpoints, locks, failures }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
