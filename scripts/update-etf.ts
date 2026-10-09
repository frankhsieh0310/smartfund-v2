import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  acquireLifecycleLock,
  completeLifecycleRun,
  createLifecycleRun,
  createSummary,
  failLifecycleRun,
  heartbeatLifecycleLock,
  loadLifecycleResumeCheckpoint,
  persistLifecycleCheckpoint,
  recoverOrphanedLifecycleRun,
  releaseLifecycleLock,
} from "./data/production/run-lifecycle.ts";

type EtfItem = { id: string; code: string; latestDate: Date | null };
type TwseRow = { date: Date; price: number; volume: number };
type TwsePayload = { stat?: string; data?: string[][] };

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const JOB_ID = "twse-domestic-etf-daily";
const RUN_TYPE = "PRIMARY";
const CHECKPOINT_EVERY = 10;

function day(value: Date): string { return value.toISOString().slice(0, 10); }
function monthKey(value: Date): string { return `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, "0")}01`; }
function addMonth(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1)); }
function parseNumber(value: string): number { return Number(value.replaceAll(",", "").trim()); }
function parseTwseDate(value: string): Date {
  const [year, month, date] = value.split("/").map(Number);
  return new Date(Date.UTC(year + 1911, month - 1, date));
}
function validTradingRow(row: TwseRow): boolean {
  const weekday = row.date.getUTCDay();
  return weekday >= 1 && weekday <= 5 && Number.isFinite(row.price) && row.price > 0 && Number.isFinite(row.volume) && row.volume >= 0;
}

async function fetchMonth(code: string, month: Date): Promise<TwseRow[]> {
  const url = new URL("https://www.twse.com.tw/exchangeReport/STOCK_DAY");
  url.searchParams.set("response", "json");
  url.searchParams.set("date", monthKey(month));
  url.searchParams.set("stockNo", code);
  const response = await fetch(url, { headers: { "user-agent": "SmartFund/1.0 data@smartfund.tw" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`TWSE_HTTP_${response.status}`);
  const payload = await response.json() as TwsePayload;
  if (payload.stat !== "OK") throw new Error(`TWSE_RESPONSE_${payload.stat ?? "UNKNOWN"}`);
  return (payload.data ?? []).map((values) => ({ date: parseTwseDate(values[0]), volume: parseNumber(values[1]), price: parseNumber(values[6]) })).filter(validTradingRow);
}

async function fetchIncremental(item: EtfItem, through: Date): Promise<TwseRow[]> {
  const start = item.latestDate ? new Date(Date.UTC(item.latestDate.getUTCFullYear(), item.latestDate.getUTCMonth(), 1)) : new Date(Date.UTC(through.getUTCFullYear(), through.getUTCMonth(), 1));
  const rows: TwseRow[] = [];
  for (let cursor = start; cursor <= through; cursor = addMonth(cursor)) rows.push(...await fetchMonth(item.code, cursor));
  return rows.filter((row) => (!item.latestDate || row.date > item.latestDate) && row.date <= through).sort((a, b) => a.date.getTime() - b.date.getTime());
}

async function main(): Promise<void> {
  const owner = `twse-etf:${process.env.RAILWAY_DEPLOYMENT_ID ?? process.pid}`;
  await recoverOrphanedLifecycleRun(prisma, JOB_ID);
  if (!await acquireLifecycleLock(prisma, JOB_ID, owner)) { console.log(JSON.stringify({ jobId: JOB_ID, status: "SKIPPED_LOCKED" })); return; }
  let runId = "";
  try {
    const universe = await prisma.$queryRawUnsafe<EtfItem[]>("SELECT e.id,e.code,MAX(h.date) AS \"latestDate\" FROM etfs e LEFT JOIN etf_history h ON h.etf_id=e.id AND h.price IS NOT NULL WHERE e.is_active=TRUE AND (COALESCE(e.exchange,'') ILIKE '%TW%' OR e.currency='TWD') GROUP BY e.id,e.code ORDER BY e.code");
    if (!universe.length) throw new Error("TWSE_ETF_UNIVERSE_EMPTY");
    const probeRows = await fetchMonth(universe[0].code, new Date());
    const target = probeRows.at(-1)?.date;
    if (!target) throw new Error("TWSE_PROVIDER_NOT_READY");
    const completed = await prisma.$queryRawUnsafe<{ exists: boolean }[]>("SELECT EXISTS(SELECT 1 FROM production_scheduler_runs WHERE job_id=$1 AND run_type=$2 AND target_trade_date=$3::date AND status='COMPLETED' AND exit_code=0) AS exists", JOB_ID, RUN_TYPE, day(target));
    if (completed[0]?.exists) { console.log(JSON.stringify({ jobId: JOB_ID, status: "SKIPPED_COMPLETED", targetTradeDate: day(target) })); return; }
    runId = await createLifecycleRun(prisma, JOB_ID, "TWSE_ETF", RUN_TYPE, { targetTradeDate: target, expectedTradingDate: target, providerLatestDate: target, runKey: `${JOB_ID}:${day(target)}:${RUN_TYPE}`, universeCount: universe.length });
    const summary = createSummary();
    const resume = await loadLifecycleResumeCheckpoint(prisma, JOB_ID, { targetTradeDate: target, runType: RUN_TYPE });
    if (resume?.details) Object.assign(summary, resume.details);
    const resumeIndex = resume?.last_symbol ? universe.findIndex((item) => item.code === resume.last_symbol) : -1;
    const selected = resumeIndex >= 0 ? universe.slice(resumeIndex + 1) : universe;
    for (let index = 0; index < selected.length; index += 1) {
      const item = selected[index];
      summary.attempted += 1;
      try {
        const rows = await fetchIncremental(item, target);
        for (const row of rows) {
          await prisma.$executeRawUnsafe("INSERT INTO etf_history (id,etf_id,date,price,volume) VALUES ($1,$2,$3::date,$4,$5) ON CONFLICT (etf_id,date) DO UPDATE SET price=EXCLUDED.price,volume=EXCLUDED.volume", randomUUID(), item.id, day(row.date), row.price, row.volume);
        }
        const newest = rows.at(-1);
        if (newest) await prisma.$executeRawUnsafe("UPDATE etfs SET latest_price=$2,volume=$3,price_updated_at=NOW(),updated_at=NOW(),data_provider='TWSE_OFFICIAL_STOCK_DAY' WHERE id=$1", item.id, newest.price, newest.volume);
        summary.completed += 1; summary.success += rows.length ? 1 : 0; summary.noUpdate += rows.length ? 0 : 1; summary.inserted += rows.length; summary.upToProviderLatest += newest && day(newest.date) === day(target) ? 1 : 0;
        await prisma.$executeRawUnsafe("DELETE FROM production_scheduler_failures WHERE job_id=$1 AND stock_id=$2", JOB_ID, item.id);
      } catch (error) {
        summary.failed += 1; summary.retryableFailure += 1;
        const message = error instanceof Error ? error.message : String(error);
        await prisma.$executeRawUnsafe("INSERT INTO production_scheduler_failures (job_id,stock_id,symbol,attempts,last_error,error_type,last_attempted_at,next_retry_at,classification,resolved) VALUES ($1,$2,$3,1,$4,'TWSE_FETCH_ERROR',NOW(),NOW()+INTERVAL '15 minutes','RETRYABLE_FAILURE',FALSE) ON CONFLICT (job_id,stock_id) DO UPDATE SET attempts=production_scheduler_failures.attempts+1,last_error=EXCLUDED.last_error,last_attempted_at=NOW(),next_retry_at=EXCLUDED.next_retry_at,resolved=FALSE", JOB_ID, item.id, item.code, message);
      }
      if ((index + 1) % CHECKPOINT_EVERY === 0 || index + 1 === selected.length) {
        await persistLifecycleCheckpoint(prisma, runId, summary, item.code, { jobId: JOB_ID, targetTradeDate: target, runType: RUN_TYPE });
        await heartbeatLifecycleLock(prisma, JOB_ID, owner);
      }
    }
    const validation = { status: summary.failed === 0 ? "PASS" : "FAIL", source: "TWSE_OFFICIAL_STOCK_DAY", targetTradeDate: day(target), universe: universe.length, weekendRowsAccepted: 0 };
    await completeLifecycleRun(prisma, runId, summary, target, validation);
    console.log(JSON.stringify({ jobId: JOB_ID, status: validation.status, targetTradeDate: day(target), ...summary }));
  } catch (error) { if (runId) await failLifecycleRun(prisma, runId, error); throw error; }
  finally { await releaseLifecycleLock(prisma, JOB_ID, owner); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
