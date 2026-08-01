import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  closeTime,
  currentDstStatus,
  latestClosedTradingDate,
  loadExchangeCalendarRegistry,
  marketClock,
  nextDispatch,
  zonedDateTimeToUtc,
} from "./exchange-calendar.ts";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });

function taipei(value: Date): string {
  const clock = marketClock("Asia/Taipei", value);
  return `${clock.date} ${clock.time}`;
}

function specialCloses(values: Array<{ date: string; close: string; type: string }>): string {
  return values.length ? values.map((value) => `${value.date} ${value.close} (${value.type})`).join("<br>") : "None configured";
}

async function main(): Promise<void> {
  const now = new Date();
  const registry = await loadExchangeCalendarRegistry();
  const rows: string[] = [];
  for (const job of registry.jobs) {
    const target = latestClosedTradingDate(job, now);
    const closeInstant = zonedDateTimeToUtc(target, closeTime(job, target), job.timezone);
    const next = nextDispatch(job, now);
    const runs = await prisma.$queryRawUnsafe<Array<{ status: string; trade_date: Date | null }>>(
      "SELECT status,COALESCE(target_trade_date,latest_trading_date::date) AS trade_date FROM production_scheduler_runs WHERE job_id=$1 AND run_type='PRIMARY' AND status='COMPLETED' AND validation_status='PASS' AND exit_code=0 ORDER BY completed_at DESC LIMIT 1",
      job.id,
    );
    const locks = await prisma.$queryRawUnsafe<Array<{ active: boolean }>>(
      "SELECT EXISTS(SELECT 1 FROM production_scheduler_locks WHERE job_id=$1 AND expires_at>NOW() AND updated_at>NOW()-INTERVAL '10 minutes') AS active",
      job.id,
    );
    const status = locks[0]?.active ? "RUNNING" : (runs[0] ? "SCHEDULED / LAST COMPLETE" : "SCHEDULED / NOT YET COMPLETE");
    rows.push(`| ${job.market} | ${job.exchange} | ${job.timezone} | ${job.regularSession.close} | ${specialCloses(job.specialSessions)} | ${currentDstStatus(job.timezone, now)} | ${taipei(closeInstant)} | ${job.stabilizationDelayMinutes} min | ${taipei(next.dispatchAt)} | [Official calendar](${job.holidayCalendarSource}) | ${status} | ${job.id} | ${job.id} | ${job.id}:{tradeDate}:PRIMARY | ${runs[0]?.trade_date?.toISOString().slice(0, 10) ?? "None"} |`);
  }
  const content = `# Exchange Close Daily Schedule

Generated from the Production exchange calendar registry at ${now.toISOString()}.

Taiwan execution time is calculated from each exchange's IANA timezone, official trading date, special close and stabilization delay. It changes with daylight-saving time and special sessions; it is not a permanently fixed clock time.

| Market | Exchange | IANA Timezone | Local Regular Close | Local Half-Day / Special Close | Current DST Status | Taiwan Close Time (latest closed session) | Stabilization Delay | Next Scheduled Dispatch (Taiwan) | Holiday Source | Scheduler Status | Job Name | Lock Key | Checkpoint Key | Last Completed Trade Date |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Runtime rules

- Railway Cron polls every ${registry.pollIntervalMinutes} minutes and dispatches at most ${registry.maxNewMarketJobsPerDispatch ?? 1} new market per poll, with no more than ${registry.maxConcurrentMarketJobs ?? 3} active market jobs.
- A job is eligible only after the exchange's real close plus stabilization delay and after Yahoo exposes a complete target-date daily candle.
- Every job reads the market's complete active Universe; priority, volume and popularity are not filters.
- The execution identity is market + targetTradeDate + runType. Locks, checkpoints, retries and failure rows are market-isolated.
- Calendar registry last sync: ${registry.lastCalendarSync}; configured through: ${registry.calendarValidThrough}.
`;
  const output = join(process.cwd(), "docs", "exchange-close-daily-schedule.md");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, content, "utf8");
  console.log(JSON.stringify({ output, markets: registry.jobs.length, generatedAt: now.toISOString() }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
