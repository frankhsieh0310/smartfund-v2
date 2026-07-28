import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { fetchYahooChartPeriod } from "../../../lib/services/dataProviders/yahoo/yahooClient.ts";

type Job = {
  id: string;
  exchange: string;
  timezone: string;
  primaryTime: string;
  retryTime: string;
  weekdays: number[];
};
type Config = { jobs: Job[] };
type RunType = "PRIMARY" | "RETRY";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const selectedJob = args.find((value) => value.startsWith("--job="))?.slice(6);
const runAllDue = args.includes("--all-due");
const root = process.cwd();

function clock(timezone: string, now = new Date()): { day: string; time: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
  };
}

async function loadConfig(): Promise<Config> {
  return JSON.parse(await readFile(join(root, "config", "production-yahoo-daily-jobs.json"), "utf8")) as Config;
}

async function lastSuccessDay(jobId: string, timezone: string, runType: RunType): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<{ started_at: Date }[]>(
    'SELECT started_at FROM production_scheduler_runs WHERE job_id = $1 AND run_type = $2 AND status = \'COMPLETED\' ORDER BY started_at DESC LIMIT 1', jobId, runType,
  );
  return rows[0] ? clock(timezone, rows[0].started_at).day : null;
}

async function acquire(jobId: string, owner: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ job_id: string }[]>(
    'INSERT INTO production_scheduler_locks (job_id, owner, expires_at, updated_at) VALUES ($1, $2, NOW() + INTERVAL \'45 minutes\', NOW()) ON CONFLICT (job_id) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at, updated_at = NOW() WHERE production_scheduler_locks.expires_at < NOW() RETURNING job_id',
    jobId, owner,
  );
  return rows.length === 1;
}

async function release(jobId: string, owner: string): Promise<void> {
  await prisma.$executeRawUnsafe('DELETE FROM production_scheduler_locks WHERE job_id = $1 AND owner = $2', jobId, owner);
}

async function execute(job: Job, runType: RunType): Promise<Record<string, unknown>> {
  const runId = randomUUID();
  const owner = `${process.env.RAILWAY_DEPLOYMENT_ID ?? process.env.HOSTNAME ?? "worker"}:${process.pid}:${runId}`;
  if (!await acquire(job.id, owner)) return { jobId: job.id, status: "SKIPPED_LOCKED" };
  const summary = { attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0 };
  try {
    await prisma.$executeRawUnsafe('INSERT INTO production_scheduler_runs (id, job_id, exchange, run_type, status) VALUES ($1, $2, $3, $4, \'IN_PROGRESS\')', runId, job.id, job.exchange, runType);
    const failedStockIds = runType === "RETRY"
      ? (await prisma.$queryRawUnsafe<{ stock_id: string }[]>('SELECT stock_id FROM production_scheduler_failures WHERE job_id = $1', job.id)).map((row) => row.stock_id)
      : [];
    const stocks = await prisma.stock.findMany({
      where: { exchange: job.exchange, isActive: true, yahooSymbol: { not: "" }, latestDate: { not: null }, ...(runType === "RETRY" ? { id: { in: failedStockIds } } : {}) },
      orderBy: { yahooSymbol: "asc" },
      select: { id: true, yahooSymbol: true, latestDate: true },
    });
    for (const stock of stocks) {
      summary.attempted += 1;
      try {
        const period1 = Math.floor(stock.latestDate!.getTime() / 1000);
        const period2 = Math.floor((Date.now() + 86_400_000) / 1000);
        const candles = (await fetchYahooChartPeriod(stock.yahooSymbol, period1, period2))?.candles ?? [];
        for (const candle of candles.filter((row) => row.close !== null && row.date >= stock.latestDate!)) {
          const date = candle.date;
          const existing = await prisma.stockHistory.findUnique({ where: { stockId_date: { stockId: stock.id, date } }, select: { id: true } });
          await prisma.stockHistory.upsert({
            where: { stockId_date: { stockId: stock.id, date } },
            create: { stockId: stock.id, date, open: candle.open, high: candle.high, low: candle.low, close: candle.close!, adjustedClose: candle.adjClose, volume: candle.volume, source: "YAHOO", sourceSymbol: stock.yahooSymbol, providerMethod: "YAHOO_CHART_API", importedAt: new Date(), updatedAt: new Date() },
            update: { open: candle.open, high: candle.high, low: candle.low, close: candle.close!, adjustedClose: candle.adjClose, volume: candle.volume, source: "YAHOO", sourceSymbol: stock.yahooSymbol, providerMethod: "YAHOO_CHART_API", updatedAt: new Date() },
          });
          if (existing) summary.updated += 1; else summary.inserted += 1;
        }
        const latest = candles.filter((row) => row.close !== null).at(-1);
        if (latest) await prisma.stock.update({ where: { id: stock.id }, data: { latestDate: latest.date, latestClose: latest.close! } });
        await prisma.$executeRawUnsafe('DELETE FROM production_scheduler_failures WHERE job_id = $1 AND stock_id = $2', job.id, stock.id);
        summary.completed += 1;
      } catch (error) {
        summary.failed += 1;
        await prisma.$executeRawUnsafe('INSERT INTO production_scheduler_failures (job_id, stock_id, symbol, attempts, last_error, last_attempted_at) VALUES ($1, $2, $3, 1, $4, NOW()) ON CONFLICT (job_id, stock_id) DO UPDATE SET attempts = production_scheduler_failures.attempts + 1, last_error = EXCLUDED.last_error, last_attempted_at = NOW()', job.id, stock.id, stock.yahooSymbol, error instanceof Error ? error.message : String(error));
      }
    }
    await prisma.$executeRawUnsafe('UPDATE production_scheduler_runs SET status = \'COMPLETED\', completed_at = NOW(), attempted = $2, completed = $3, inserted = $4, updated = $5, failed = $6, details = $7::jsonb WHERE id = $1', runId, summary.attempted, summary.completed, summary.inserted, summary.updated, summary.failed, JSON.stringify(summary));
    return { jobId: job.id, runType, status: "COMPLETED", ...summary };
  } catch (error) {
    await prisma.$executeRawUnsafe('UPDATE production_scheduler_runs SET status = \'FAILED\', completed_at = NOW(), error = $2 WHERE id = $1', runId, error instanceof Error ? error.message : String(error)).catch(() => undefined);
    throw error;
  } finally {
    await release(job.id, owner);
  }
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const results: Record<string, unknown>[] = [];
  for (const job of config.jobs.filter((value) => !selectedJob || value.id === selectedJob)) {
    const now = clock(job.timezone);
    if (!job.weekdays.includes(now.weekday)) continue;
    const candidates: Array<[RunType, string]> = [["PRIMARY", job.primaryTime], ["RETRY", job.retryTime]];
    for (const [runType, time] of candidates) {
      const due = runAllDue ? now.time >= time : now.time === time;
      if (due && await lastSuccessDay(job.id, job.timezone, runType) !== now.day) results.push(await execute(job, runType));
    }
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
