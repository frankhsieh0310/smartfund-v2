import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

type Job = {
  id: string;
  exchange: string;
  exchanges?: string[];
  country?: string;
  timezone: string;
  primaryTime: string;
  retryTime: string;
};
type Config = { jobs: Job[] };
type Run = {
  job_id: string;
  exchange: string;
  run_type: string;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  attempted: number;
  completed: number;
  failed: number;
  inserted: number;
  updated: number;
  latest_trading_date: Date | null;
  exit_code: number | null;
};
type Checkpoint = { job_id: string; last_symbol: string | null; processed: number; succeeded: number; failed: number; updated_at: Date };
type Lock = { job_id: string; expires_at: Date };
type Failure = { job_id: string; count: bigint };

const prisma = new PrismaClient();

function stockWhere(job: Job) {
  return {
    exchange: { in: job.exchanges ?? [job.exchange] },
    ...(job.country ? { country: job.country } : {}),
    isActive: true,
    yahooSymbol: { not: "" },
  };
}

function health(run: Run | undefined): number | null {
  if (!run || run.attempted === 0) return null;
  return Number(((run.completed / run.attempted) * 100).toFixed(2));
}

async function main(): Promise<void> {
  const config = JSON.parse(await readFile(join(process.cwd(), "config", "production-yahoo-daily-jobs.json"), "utf8")) as Config;
  const [runs, checkpoints, locks, failures] = await Promise.all([
    prisma.$queryRawUnsafe<Run[]>("SELECT job_id, exchange, run_type, status, started_at, completed_at, attempted, completed, failed, inserted, updated, latest_trading_date, exit_code FROM production_scheduler_runs ORDER BY started_at DESC"),
    prisma.$queryRawUnsafe<Checkpoint[]>("SELECT job_id, last_symbol, processed, succeeded, failed, updated_at FROM production_scheduler_checkpoints"),
    prisma.$queryRawUnsafe<Lock[]>("SELECT job_id, expires_at FROM production_scheduler_locks"),
    prisma.$queryRawUnsafe<Failure[]>("SELECT job_id, COUNT(*) AS count FROM production_scheduler_failures WHERE resolved = false GROUP BY job_id"),
  ]);

  const marketHealth = await Promise.all(config.jobs.map(async (job) => {
    const where = stockWhere(job);
    const [universe, latest] = await Promise.all([
      prisma.stock.count({ where }),
      prisma.stock.findFirst({ where: { ...where, latestDate: { not: null } }, orderBy: { latestDate: "desc" }, select: { latestDate: true } }),
    ]);
    const run = runs.find((item) => item.job_id === job.id);
    const checkpoint = checkpoints.find((item) => item.job_id === job.id) ?? null;
    const lock = locks.find((item) => item.job_id === job.id) ?? null;
    const failure = failures.find((item) => item.job_id === job.id);
    const durationMs = run?.completed_at ? run.completed_at.getTime() - run.started_at.getTime() : null;
    return {
      market: job.exchange,
      jobId: job.id,
      scheduler: { timezone: job.timezone, primary: job.primaryTime, retry: job.retryTime },
      universe,
      attempted: run?.attempted ?? 0,
      completed: run?.completed ?? 0,
      failed: run?.failed ?? 0,
      retry: failure ? Number(failure.count) : 0,
      checkpoint: checkpoint ? { lastSymbol: checkpoint.last_symbol, processed: checkpoint.processed, succeeded: checkpoint.succeeded, failed: checkpoint.failed, updatedAt: checkpoint.updated_at } : null,
      health: health(run),
      latencyMs: durationMs,
      latestTradeDate: run?.latest_trading_date ?? latest?.latestDate ?? null,
      lock: lock ? { status: "LOCKED", expiresAt: lock.expires_at } : { status: "RELEASED" },
      failureQueue: { jobId: job.id, open: failure ? Number(failure.count) : 0 },
      lastRun: run ?? null,
    };
  }));

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), engineCount: config.jobs.length, marketHealth }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
