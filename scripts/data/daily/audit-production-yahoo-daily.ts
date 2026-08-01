import { PrismaClient } from "@prisma/client";
import {
  closeTime,
  currentDstStatus,
  dispatchAt,
  latestClosedTradingDate,
  loadExchangeCalendarRegistry,
  marketClock,
  nextDispatch,
} from "./exchange-calendar.ts";

type Run = {
  id: string;
  job_id: string;
  run_type: string;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  attempted: number;
  completed: number;
  failed: number;
  latest_trading_date: Date | null;
  target_trade_date: Date | null;
  validation_status: string | null;
  exit_code: number | null;
  error: string | null;
};

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });

function runStatus(run: Run | undefined, lockActive: boolean, now: Date): string {
  if (lockActive) return "RUNNING";
  if (!run) return "SCHEDULED";
  if (run.status === "COMPLETED" && run.validation_status === "PASS" && run.exit_code === 0) return "COMPLETE";
  if (run.status === "PAUSED" || run.status === "PAUSE_REQUESTED") return "PAUSED";
  if (run.status === "FAILED") return "FAILED";
  if (run.status === "IN_PROGRESS" && now.getTime() - run.started_at.getTime() > 600_000) return "STALE_LOCK";
  return run.status;
}

async function main(): Promise<void> {
  const now = new Date();
  const registry = await loadExchangeCalendarRegistry();
  const [runs, checkpoints, locks, failures] = await Promise.all([
    prisma.$queryRawUnsafe<Run[]>("SELECT id,job_id,run_type,status,started_at,completed_at,attempted,completed,failed,latest_trading_date,target_trade_date,validation_status,exit_code,error FROM production_scheduler_runs WHERE run_type IN ('PRIMARY','RETRY') ORDER BY started_at DESC"),
    prisma.$queryRawUnsafe<Array<{ job_id: string; target_trade_date: Date | null; run_type: string | null; last_symbol: string | null; processed: number; succeeded: number; failed: number; updated_at: Date }>>("SELECT job_id,target_trade_date,run_type,last_symbol,processed,succeeded,failed,updated_at FROM production_scheduler_checkpoints ORDER BY updated_at DESC"),
    prisma.$queryRawUnsafe<Array<{ job_id: string; owner: string; expires_at: Date; updated_at: Date }>>("SELECT job_id,owner,expires_at,updated_at FROM production_scheduler_locks ORDER BY updated_at DESC"),
    prisma.$queryRawUnsafe<Array<{ job_id: string; open: number; retryable: number }>>("SELECT job_id,COUNT(*) FILTER (WHERE resolved=FALSE)::int AS open,COUNT(*) FILTER (WHERE resolved=FALSE AND classification='RETRYABLE_FAILURE')::int AS retryable FROM production_scheduler_failures GROUP BY job_id"),
  ]);
  const markets = [];
  for (const job of registry.jobs) {
    const where = { exchange: { in: job.exchanges }, country: job.country, isActive: true };
    const [universe, historicalCompleted, databaseLatest] = await Promise.all([
      prisma.stock.count({ where }),
      prisma.stock.count({ where: { ...where, historyBackfilledAt: { not: null } } }),
      prisma.stock.findFirst({ where: { ...where, latestDate: { not: null } }, orderBy: { latestDate: "desc" }, select: { latestDate: true } }),
    ]);
    const marketRuns = runs.filter((run) => run.job_id === job.id);
    const latestRun = marketRuns[0];
    const lastSuccessfulRun = marketRuns.find((run) => run.status === "COMPLETED" && run.validation_status === "PASS" && run.exit_code === 0) ?? null;
    const lastFailedRun = marketRuns.find((run) => run.status === "FAILED") ?? null;
    const checkpoint = checkpoints.find((row) => row.job_id === job.id) ?? null;
    const lock = locks.find((row) => row.job_id === job.id) ?? null;
    const lockActive = Boolean(lock && lock.expires_at > now && lock.updated_at.getTime() > now.getTime() - 600_000);
    const targetTradeDate = latestClosedTradingDate(job, now);
    const targetDispatch = dispatchAt(job, targetTradeDate);
    const next = nextDispatch(job, now);
    const failure = failures.find((row) => row.job_id === job.id);
    markets.push({
      market: job.market,
      exchange: job.exchange,
      universe,
      historicalCompleted,
      status: runStatus(latestRun, lockActive, now),
      dailyLatestRunStatus: latestRun?.status ?? "NOT_STARTED",
      dailyAttempted: latestRun?.attempted ?? 0,
      dailyCompleted: latestRun?.completed ?? 0,
      dailyFailed: latestRun?.failed ?? 0,
      latestCompletedTradeDate: lastSuccessfulRun?.target_trade_date ?? lastSuccessfulRun?.latest_trading_date ?? databaseLatest?.latestDate ?? null,
      databaseLatestTradeDate: databaseLatest?.latestDate ?? null,
      currentCheckpoint: checkpoint,
      activeLock: lockActive ? lock : null,
      lastHeartbeat: lock?.updated_at ?? null,
      lastSuccessfulRun,
      lastFailedRun,
      scheduler: {
        enabled: job.schedulerEnabled,
        timezone: job.timezone,
        currentLocalClock: marketClock(job.timezone, now),
        regularClose: job.regularSession.close,
        targetClose: closeTime(job, targetTradeDate),
        targetTradeDate,
        targetDispatchAt: targetDispatch,
        nextTargetTradeDate: next.targetTradeDate,
        nextDispatchAt: next.dispatchAt,
        dstStatus: currentDstStatus(job.timezone, now),
        exchangeCloseAware: true,
      },
      openFailures: failure?.open ?? 0,
      retryableFailures: failure?.retryable ?? 0,
      staleInProgress: marketRuns.filter((run) => run.status === "IN_PROGRESS" && !lockActive && now.getTime() - run.started_at.getTime() > 600_000).map((run) => run.id),
    });
  }
  console.log(JSON.stringify({ generatedAt: now.toISOString(), engineCount: registry.jobs.length, calendarValidThrough: registry.calendarValidThrough, markets }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
