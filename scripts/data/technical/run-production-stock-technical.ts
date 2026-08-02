import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  acquireLifecycleLock, completeLifecycleRun, createLifecycleRun, createSummary,
  failLifecycleRun, heartbeatLifecycleLock, loadLifecycleResumeCheckpoint,
  pauseLifecycleRun, persistLifecycleCheckpoint, recoverOrphanedLifecycleRun,
  releaseLifecycleLock,
} from "../production/run-lifecycle.ts";

type Stock = { id: string; ticker: string; exchange: string; isActive: boolean };
type Price = { date: Date; high: { toNumber(): number } | null; low: { toNumber(): number } | null; close: { toNumber(): number } };
type Row = Record<string, string | number | null> & { id: string; date: string };
type Market = "JPX" | "KSC" | "KOE";

const rawMarket = process.argv.find((v) => v.startsWith("--market="))?.slice(9).trim().toUpperCase();
if (!rawMarket) throw new Error("MARKET_REQUIRED:pass --market=JPX, --market=KSC, or --market=KOE");
if (!(["JPX", "KSC", "KOE"] as string[]).includes(rawMarket)) throw new Error(`UNSUPPORTED_TECHNICAL_MARKET:${rawMarket}`);
const MARKET = rawMarket as Market;
const DRY_RUN = process.argv.includes("--dry-run");
const maxArg = process.argv.find((v) => v.startsWith("--max-symbols="))?.slice(14);
const MAX_SYMBOLS = Number.parseInt(maxArg ?? "25", 10);
if (!Number.isSafeInteger(MAX_SYMBOLS) || MAX_SYMBOLS < 1 || MAX_SYMBOLS > 250) throw new Error(`INVALID_MAX_SYMBOLS:${maxArg ?? ""}`);
const JOB_ID = `stock-technical-${MARKET.toLowerCase()}-historical`;
const RUN_TYPE = "STOCK_TECHNICAL_HISTORICAL";
const FORMULA_VERSION = "TECHNICAL_V1";
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });

const finite = (value: number | null): number | null => value !== null && Number.isFinite(value) ? Number(value.toFixed(8)) : null;

function sma(values: number[], end: number, period: number): number | null {
  if (end + 1 < period) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i += 1) sum += values[i]!;
  return sum / period;
}

function ema(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return out;
  out[period - 1] = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) out[i] = (values[i]! - out[i - 1]!) * k + out[i - 1]!;
  return out;
}

function signal(values: Array<number | null>, period = 9): Array<number | null> {
  const out: Array<number | null> = Array(values.length).fill(null);
  const first = values.findIndex((value) => value !== null);
  if (first < 0 || values.length - first < period) return out;
  out[first + period - 1] = (values.slice(first, first + period) as number[]).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = first + period; i < values.length; i += 1) out[i] = (values[i]! - out[i - 1]!) * k + out[i - 1]!;
  return out;
}

function rsi(values: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i]! - values[i - 1]!;
    gains += Math.max(change, 0); losses += Math.max(-change, 0);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function atr(high: number[], low: number[], close: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = Array(close.length).fill(null);
  if (close.length < period) return out;
  const tr = close.map((_, i) => i === 0 ? high[i]! - low[i]! : Math.max(high[i]! - low[i]!, Math.abs(high[i]! - close[i - 1]!), Math.abs(low[i]! - close[i - 1]!)));
  let current = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = current;
  for (let i = period; i < close.length; i += 1) { current = (current * (period - 1) + tr[i]!) / period; out[i] = current; }
  return out;
}

function kd(high: number[], low: number[], close: number[]): { k: Array<number | null>; d: Array<number | null> } {
  const k: Array<number | null> = Array(close.length).fill(null), d: Array<number | null> = Array(close.length).fill(null);
  let previousK = 50, previousD = 50;
  for (let i = 8; i < close.length; i += 1) {
    const highest = Math.max(...high.slice(i - 8, i + 1)), lowest = Math.min(...low.slice(i - 8, i + 1));
    const rsv = highest === lowest ? 50 : (close[i]! - lowest) / (highest - lowest) * 100;
    previousK = (previousK * 2 + rsv) / 3; previousD = (previousD * 2 + previousK) / 3;
    k[i] = previousK; d[i] = previousD;
  }
  return { k, d };
}

function bands(values: number[], end: number): { middle: number | null; upper: number | null; lower: number | null } {
  const middle = sma(values, end, 20);
  if (middle === null) return { middle: null, upper: null, lower: null };
  let variance = 0;
  for (let i = end - 19; i <= end; i += 1) variance += (values[i]! - middle) ** 2;
  const deviation = Math.sqrt(variance / 20);
  return { middle, upper: middle + 2 * deviation, lower: middle - 2 * deviation };
}

function calculate(prices: Price[]): Row[] {
  const valid = prices.filter((p) => p.high !== null && p.low !== null);
  const close = valid.map((p) => p.close.toNumber()), high = valid.map((p) => p.high!.toNumber()), low = valid.map((p) => p.low!.toNumber());
  const ema12 = ema(close, 12), ema26 = ema(close, 26);
  const macd = close.map((_, i) => ema12[i] !== null && ema26[i] !== null ? ema12[i]! - ema26[i]! : null);
  const macdSignal = signal(macd), rsi14 = rsi(close), atr14 = atr(high, low, close), stochastic = kd(high, low, close);
  return valid.flatMap((price, i) => {
    if (i < 4) return [];
    const bollinger = bands(close, i);
    return [{ id: randomUUID(), date: price.date.toISOString().slice(0, 10),
      ma5: finite(sma(close, i, 5)), ma20: finite(sma(close, i, 20)), ma60: finite(sma(close, i, 60)),
      ma120: finite(sma(close, i, 120)), ma240: finite(sma(close, i, 240)), ema12: finite(ema12[i]), ema26: finite(ema26[i]),
      macd: finite(macd[i]), macdSignal: finite(macdSignal[i]), macdHistogram: finite(macd[i] !== null && macdSignal[i] !== null ? macd[i]! - macdSignal[i]! : null),
      kdK: finite(stochastic.k[i]), kdD: finite(stochastic.d[i]), rsi14: finite(rsi14[i]), atr14: finite(atr14[i]),
      bollingerUpper: finite(bollinger.upper), bollingerMiddle: finite(bollinger.middle), bollingerLower: finite(bollinger.lower) }];
  });
}

async function upsertRows(stock: Stock, rows: Row[]): Promise<{ inserted: number; updated: number }> {
  if (stock.exchange !== MARKET || !stock.isActive) throw new Error(`STOCK_OUTSIDE_MARKET_SCOPE:${stock.ticker}`);
  if (rows.length === 0) throw new Error("INSUFFICIENT_PRICE_HISTORY");
  const existing = await prisma.stockTechnical.count({ where: { stockId: stock.id } });
  for (let offset = 0; offset < rows.length; offset += 2_000) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_technical (id,stock_id,date,ma5,ma20,ma60,ma120,ma240,ema12,ema26,macd,macd_signal,macd_histogram,kd_k,kd_d,rsi14,atr14,bollinger_upper,bollinger_middle,bollinger_lower)
       SELECT value->>'id',$1,(value->>'date')::date,NULLIF(value->>'ma5','')::numeric,NULLIF(value->>'ma20','')::numeric,NULLIF(value->>'ma60','')::numeric,NULLIF(value->>'ma120','')::numeric,NULLIF(value->>'ma240','')::numeric,NULLIF(value->>'ema12','')::numeric,NULLIF(value->>'ema26','')::numeric,NULLIF(value->>'macd','')::numeric,NULLIF(value->>'macdSignal','')::numeric,NULLIF(value->>'macdHistogram','')::numeric,NULLIF(value->>'kdK','')::numeric,NULLIF(value->>'kdD','')::numeric,NULLIF(value->>'rsi14','')::numeric,NULLIF(value->>'atr14','')::numeric,NULLIF(value->>'bollingerUpper','')::numeric,NULLIF(value->>'bollingerMiddle','')::numeric,NULLIF(value->>'bollingerLower','')::numeric
       FROM jsonb_array_elements($2::jsonb) value ON CONFLICT (stock_id,date) DO UPDATE SET ma5=EXCLUDED.ma5,ma20=EXCLUDED.ma20,ma60=EXCLUDED.ma60,ma120=EXCLUDED.ma120,ma240=EXCLUDED.ma240,ema12=EXCLUDED.ema12,ema26=EXCLUDED.ema26,macd=EXCLUDED.macd,macd_signal=EXCLUDED.macd_signal,macd_histogram=EXCLUDED.macd_histogram,kd_k=EXCLUDED.kd_k,kd_d=EXCLUDED.kd_d,rsi14=EXCLUDED.rsi14,atr14=EXCLUDED.atr14,bollinger_upper=EXCLUDED.bollinger_upper,bollinger_middle=EXCLUDED.bollinger_middle,bollinger_lower=EXCLUDED.bollinger_lower`,
      stock.id, JSON.stringify(rows.slice(offset, offset + 2_000)),
    );
  }
  const inserted = Math.max(0, rows.length - existing);
  return { inserted, updated: rows.length - inserted };
}

async function recordFailure(stock: Stock, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.productionSchedulerFailure.upsert({
    where: { jobId_stockId: { jobId: JOB_ID, stockId: stock.id } },
    create: { jobId: JOB_ID, stockId: stock.id, symbol: stock.ticker, lastError: message, errorType: "TECHNICAL_CALCULATION", classification: "RETRYABLE_FAILURE" },
    update: { symbol: stock.ticker, lastError: message, errorType: "TECHNICAL_CALCULATION", classification: "RETRYABLE_FAILURE", resolved: false, attempts: { increment: 1 }, lastAttemptedAt: new Date() },
  });
}

async function findCompletionTargets(afterTicker: string | null | undefined, limit: number): Promise<Stock[]> {
  return prisma.$queryRawUnsafe<Stock[]>(
    `SELECT stock.id, stock.ticker, stock.exchange, stock.is_active AS "isActive"
       FROM stocks stock
      WHERE stock.exchange = $1
        AND stock.is_active = TRUE
        AND stock.ticker > $2
        AND EXISTS (SELECT 1 FROM stock_history history WHERE history.stock_id = stock.id OFFSET 4 LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM stock_technical technical WHERE technical.stock_id = stock.id)
      ORDER BY stock.ticker ASC, stock.id ASC
      LIMIT $3`,
    MARKET,
    afterTicker ?? "",
    limit,
  );
}

async function main(): Promise<void> {
  console.log(`[STOCK_TECHNICAL] MARKET=${MARKET} MODE=${DRY_RUN ? "DRY_RUN" : "RUN"} JOB_ID=${JOB_ID} FORMULA_VERSION=${FORMULA_VERSION}`);
  const stocks = await prisma.stock.findMany({ where: { exchange: MARKET, isActive: true }, select: { id: true, ticker: true, exchange: true, isActive: true }, orderBy: [{ ticker: "asc" }, { id: "asc" }] });
  if (stocks.length === 0) throw new Error(`MARKET_UNIVERSE_EMPTY:${MARKET}`);
  if (stocks.some((s) => s.exchange !== MARKET || !s.isActive)) throw new Error(`MARKET_SCOPE_UNCONFIRMED:${MARKET}`);
  const resume = await loadLifecycleResumeCheckpoint(prisma, JOB_ID);
  const resumeIndex = resume?.last_symbol ? stocks.findIndex((s) => s.ticker === resume.last_symbol) : -1;
  if (resume?.last_symbol && resumeIndex < 0) throw new Error(`CHECKPOINT_OUTSIDE_MARKET_SCOPE:${resume.last_symbol}`);
  const selected = await findCompletionTargets(resume?.last_symbol, MAX_SYMBOLS);
  const [activeLocks, activeRuns, histories] = await Promise.all([
    prisma.productionSchedulerLock.count({ where: { jobId: JOB_ID, expiresAt: { gt: new Date() } } }),
    prisma.productionSchedulerRun.count({ where: { jobId: JOB_ID, status: { in: ["RUNNING", "IN_PROGRESS", "PAUSE_REQUESTED"] } } }),
    prisma.stockHistory.groupBy({ by: ["stockId"], where: { stockId: { in: selected.map((s) => s.id) } }, _count: { _all: true } }),
  ]);
  const historyCount = new Map(histories.map((row) => [row.stockId, row._count._all]));
  console.log(JSON.stringify({ status: DRY_RUN ? (activeLocks || activeRuns ? "DRY_RUN_BLOCKED" : "DRY_RUN_READY") : "PREFLIGHT_READY", market: MARKET, jobId: JOB_ID,
    universeCount: stocks.length, plannedCount: selected.length, plannedSymbols: selected.map((s) => s.ticker), symbolsWithAtLeast5Prices: selected.filter((s) => (historyCount.get(s.id) ?? 0) >= 5).length,
    activeLockCount: activeLocks, activeRunCount: activeRuns, checkpoint: resume ? { lastSymbol: resume.last_symbol, processed: resume.processed, succeeded: resume.succeeded, failed: resume.failed } : null, writesPerformed: false }, null, 2));
  if (DRY_RUN) { if (activeLocks || activeRuns || selected.length === 0) process.exitCode = 2; return; }
  if (process.env.LIVE_WRITE_AUTHORIZED !== "true") throw new Error("LIVE_WRITE_NOT_AUTHORIZED");
  if (activeLocks || activeRuns) throw new Error(`ACTIVE_OWNER:${JOB_ID}`);
  if (selected.length === 0) throw new Error(`NO_SYMBOLS_TO_PROCESS:${MARKET}`);

  const owner = `${process.env.SMARTFUND_NODE_ID ?? "local"}:${process.pid}`;
  let runId: string | null = null, lockHeld = false;
  const summary = createSummary();
  if (resume) Object.assign(summary, resume.details ?? { attempted: resume.processed, completed: resume.succeeded, success: resume.succeeded, failed: resume.failed });
  try {
    await recoverOrphanedLifecycleRun(prisma, JOB_ID);
    lockHeld = await acquireLifecycleLock(prisma, JOB_ID, owner);
    if (!lockHeld) throw new Error(`ACTIVE_OWNER:${JOB_ID}`);
    runId = await createLifecycleRun(prisma, JOB_ID, MARKET, RUN_TYPE, { universeCount: stocks.length });
    for (const stock of selected) {
      summary.attempted += 1;
      try {
        const prices = await prisma.stockHistory.findMany({ where: { stockId: stock.id }, select: { date: true, high: true, low: true, close: true }, orderBy: { date: "asc" } }) as Price[];
        const rows = calculate(prices), result = await upsertRows(stock, rows);
        summary.completed += 1; summary.success += 1; summary.inserted += result.inserted; summary.updated += result.updated;
        if (result.inserted === 0) summary.noUpdate += 1;
        await prisma.productionSchedulerFailure.deleteMany({ where: { jobId: JOB_ID, stockId: stock.id } });
        console.log(JSON.stringify({ market: MARKET, ticker: stock.ticker, status: "COMPLETE", priceRows: prices.length, technicalRows: rows.length, ...result, processed: summary.attempted }));
      } catch (error) {
        summary.failed += 1; summary.retryableFailure += 1; await recordFailure(stock, error);
        console.error(JSON.stringify({ market: MARKET, ticker: stock.ticker, status: "FAILED", error: error instanceof Error ? error.message : String(error), processed: summary.attempted }));
      }
      if (summary.attempted % 5 === 0 || stock === selected.at(-1)) { await persistLifecycleCheckpoint(prisma, runId, summary, stock.ticker, { jobId: JOB_ID, runType: RUN_TYPE }); await heartbeatLifecycleLock(prisma, JOB_ID, owner); }
    }
    const lastSymbol = selected.at(-1)!.ticker;
    const hasRemaining = (await findCompletionTargets(lastSymbol, 1)).length > 0;
    if (hasRemaining) { await pauseLifecycleRun(prisma, runId); console.log(JSON.stringify({ status: "PAUSED_CHECKPOINTED", market: MARKET, jobId: JOB_ID, planned: selected.length, remaining: "BOUNDED_SCAN_PENDING", checkpoint: lastSymbol, ...summary })); return; }
    const [coveredStocks, technicalRows] = await Promise.all([
      prisma.stock.count({ where: { exchange: MARKET, isActive: true, technical: { some: {} } } }),
      prisma.stockTechnical.count({ where: { stock: { exchange: MARKET, isActive: true } } }),
    ]);
    const validation = { status: summary.completed + summary.failed === summary.attempted ? "PASS" : "FAIL", market: MARKET, universe: stocks.length, processed: summary.attempted, coveredStocks, technicalRows, formulaVersion: FORMULA_VERSION, remainingEligibleTargets: 0 };
    await completeLifecycleRun(prisma, runId, summary, null, validation); console.log(JSON.stringify(validation));
  } catch (error) { if (runId) await failLifecycleRun(prisma, runId, error); throw error; }
  finally { if (lockHeld) await releaseLifecycleLock(prisma, JOB_ID, owner); }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
