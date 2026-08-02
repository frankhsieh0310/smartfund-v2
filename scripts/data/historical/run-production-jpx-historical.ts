import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  acquireLifecycleLock, completeLifecycleRun, createLifecycleRun, createSummary,
  failLifecycleRun, heartbeatLifecycleLock, loadLifecycleResumeCheckpoint,
  pauseLifecycleRun, persistLifecycleCheckpoint, recoverOrphanedLifecycleRun,
  releaseLifecycleLock,
} from "../production/run-lifecycle.ts";

type Stock = { id: string; ticker: string; yahooSymbol: string; companyName: string; exchange: string; isActive: boolean };
type Candle = { date: string; open: number | null; high: number | null; low: number | null; close: number; adjustedClose: number | null; volume: number | null };
type Market = "JPX" | "KSC" | "KOE" | "HKG" | "SHH" | "SHZ" | "SES";

const rawMarket = process.argv.find((v) => v.startsWith("--market="))?.slice(9).trim().toUpperCase();
if (!rawMarket) throw new Error("MARKET_REQUIRED:pass an explicitly supported exchange");
if (!(["JPX", "KSC", "KOE", "HKG", "SHH", "SHZ", "SES"] as string[]).includes(rawMarket)) throw new Error(`UNSUPPORTED_HISTORICAL_MARKET:${rawMarket}`);
const MARKET = rawMarket as Market;
const DRY_RUN = process.argv.includes("--dry-run");
const maxArg = process.argv.find((v) => v.startsWith("--max-symbols="))?.slice(14);
const MAX_SYMBOLS = Number.parseInt(maxArg ?? "25", 10);
if (!Number.isSafeInteger(MAX_SYMBOLS) || MAX_SYMBOLS < 1 || MAX_SYMBOLS > 250) throw new Error(`INVALID_MAX_SYMBOLS:${maxArg ?? ""}`);
const CONFIG: Record<Market, { jobId: string; dailyJobId: string | null; rawDirectory: string }> = {
  JPX: { jobId: "stock-price-jpx-historical", dailyJobId: "japan-yahoo-daily", rawDirectory: "jpx" },
  KSC: { jobId: "stock-price-ksc-historical", dailyJobId: "korea-yahoo-daily", rawDirectory: "ksc" },
  KOE: { jobId: "stock-price-koe-historical", dailyJobId: "korea-yahoo-daily", rawDirectory: "koe" },
  HKG: { jobId: "stock-price-hkg-historical", dailyJobId: "hong-kong-yahoo-daily", rawDirectory: "hkg" },
  SHH: { jobId: "stock-price-shh-historical", dailyJobId: "china-shanghai-yahoo-daily", rawDirectory: "shh" },
  SHZ: { jobId: "stock-price-shz-historical", dailyJobId: "china-shenzhen-yahoo-daily", rawDirectory: "shz" },
  SES: { jobId: "stock-price-ses-historical", dailyJobId: null, rawDirectory: "ses" },
};
const MARKET_STOCK_PREFIXES: Partial<Record<Market, readonly string[]>> = {
  SHH: ["600", "601", "603", "605", "688", "689", "900"],
  SHZ: ["000", "001", "002", "003", "200", "300", "301"],
};
const MARKET_STOCK_REGEX: Partial<Record<Market, string>> = {
  SHH: "^(600|601|603|605|688|689|900)[0-9]{3}$",
  SHZ: "^(000|001|002|003|200|300|301)[0-9]{3}$",
};
const JOB_ID = CONFIG[MARKET].jobId;
const DAILY_JOB_ID = CONFIG[MARKET].dailyJobId;
const RUN_TYPE = "STOCK_PRICE_HISTORICAL";
const RAW_ROOT = path.resolve("runtime", "historical", "yahoo", CONFIG[MARKET].rawDirectory);
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const EXCLUDED_NON_STOCK_SYMBOLS = new Set<string>();

function stockScopeWhere() {
  return {
    exchange: MARKET,
    isActive: true,
    ...(MARKET_STOCK_PREFIXES[MARKET]
      ? { OR: MARKET_STOCK_PREFIXES[MARKET]!.map((prefix) => ({ ticker: { startsWith: prefix } })) }
      : {}),
    ...(EXCLUDED_NON_STOCK_SYMBOLS.size > 0
      ? { yahooSymbol: { notIn: [...EXCLUDED_NON_STOCK_SYMBOLS] } }
      : {}),
  };
}

async function loadExplicitNonStockSymbols(): Promise<void> {
  if (MARKET !== "SES") return;
  const [etfs, assets, named] = await Promise.all([
    prisma.etf.findMany({ where: { exchange: "SES" }, select: { code: true } }),
    prisma.asset.findMany({ where: { assetType: { in: ["ETF", "FUND"] }, code: { endsWith: ".SI" } }, select: { code: true } }),
    prisma.stock.findMany({
      where: { exchange: "SES", OR: [{ companyName: { contains: "ETF", mode: "insensitive" } }, { companyName: { contains: "Fund", mode: "insensitive" } }] },
      select: { yahooSymbol: true },
    }),
  ]);
  for (const symbol of [...etfs.map((row) => row.code), ...assets.map((row) => row.code), ...named.map((row) => row.yahooSymbol)]) {
    if (symbol) EXCLUDED_NON_STOCK_SYMBOLS.add(symbol);
  }
  if (EXCLUDED_NON_STOCK_SYMBOLS.size === 0) throw new Error("MARKET_SCOPE_UNCONFIRMED:SES_NON_STOCK_REGISTRY_EMPTY");
}

function isWithinMarketStockScope(stock: Pick<Stock, "ticker" | "yahooSymbol" | "companyName" | "exchange" | "isActive">): boolean {
  const prefixes = MARKET_STOCK_PREFIXES[MARKET];
  const explicitStock = !prefixes || prefixes.some((prefix) => stock.ticker.startsWith(prefix));
  const explicitNonStock = EXCLUDED_NON_STOCK_SYMBOLS.has(stock.yahooSymbol) || (MARKET === "SES" && /(fund|etf)/i.test(stock.companyName));
  return stock.exchange === MARKET && stock.isActive && explicitStock && !explicitNonStock;
}

async function dailyWriterState(): Promise<{ activeLocks: number; activeRuns: number }> {
  if (!DAILY_JOB_ID) {
    const runs = await prisma.productionSchedulerRun.findMany({
      where: { exchange: MARKET, status: { in: ["RUNNING", "IN_PROGRESS", "PAUSE_REQUESTED"] }, startedAt: { gt: new Date(Date.now() - 10 * 60_000) } },
      select: { jobId: true },
    });
    const jobIds = [...new Set(runs.map((run) => run.jobId).filter((jobId) => jobId !== JOB_ID))];
    const activeLocks = jobIds.length === 0 ? 0 : await prisma.productionSchedulerLock.count({ where: { jobId: { in: jobIds }, expiresAt: { gt: new Date() } } });
    return { activeLocks, activeRuns: jobIds.length };
  }
  const [activeLocks, activeRuns] = await Promise.all([
    prisma.productionSchedulerLock.count({ where: { jobId: DAILY_JOB_ID, expiresAt: { gt: new Date() }, updatedAt: { gt: new Date(Date.now() - 10 * 60_000) } } }),
    prisma.productionSchedulerRun.count({ where: { jobId: DAILY_JOB_ID, status: { in: ["RUNNING", "IN_PROGRESS", "PAUSE_REQUESTED"] } } }),
  ]);
  return { activeLocks, activeRuns };
}

async function fetchYahoo(stock: Stock): Promise<{ candles: Candle[]; raw: string }> {
  if (!isWithinMarketStockScope(stock) || !stock.yahooSymbol) throw new Error(`STOCK_OUTSIDE_MARKET_SCOPE:${stock.ticker}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const period2 = Math.floor((Date.now() + 86_400_000) / 1_000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(stock.yahooSymbol)}?period1=0&period2=${period2}&interval=1d&events=history`;
    const response = await fetch(url, { headers: { "User-Agent": "SmartFund Global Stock Historical" }, signal: controller.signal });
    if (!response.ok) throw new Error(`YAHOO_HTTP_${response.status}`);
    const raw = await response.text();
    const payload = JSON.parse(raw) as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, Array<number | null>>>; adjclose?: Array<{ adjclose?: Array<number | null> }> } }> } };
    const result = payload.chart?.result?.[0];
    if (!result) throw new Error("YAHOO_NO_DATA");
    const quote = result.indicators?.quote?.[0] ?? {}, adjusted = result.indicators?.adjclose?.[0]?.adjclose ?? [];
    const candles = (result.timestamp ?? []).flatMap((timestamp, index) => {
      const close = quote.close?.[index];
      if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) return [];
      return [{ date: new Date(timestamp * 1_000).toISOString().slice(0, 10), open: quote.open?.[index] ?? null, high: quote.high?.[index] ?? null,
        low: quote.low?.[index] ?? null, close, adjustedClose: adjusted[index] ?? null, volume: quote.volume?.[index] ?? null }];
    });
    if (candles.length === 0) throw new Error("YAHOO_NO_VALID_CANDLES");
    return { candles, raw };
  } finally { clearTimeout(timeout); }
}

async function archive(stock: Stock, raw: string): Promise<string> {
  const checksum = createHash("sha256").update(raw).digest("hex");
  const directory = path.join(RAW_ROOT, stock.yahooSymbol.replace(/[^A-Za-z0-9._-]/g, "_"));
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${checksum}.json`);
  await writeFile(target, raw, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  return target;
}

async function insertCandles(stock: Stock, candles: Candle[]): Promise<number> {
  if (candles.length < 5) throw new Error(`YAHOO_INSUFFICIENT_HISTORY:${candles.length}`);
  if (await prisma.stockHistory.count({ where: { stockId: stock.id } }) > 0) return 0;
  let inserted = 0;
  for (let offset = 0; offset < candles.length; offset += 2_000) {
    const result = await prisma.stockHistory.createMany({
      data: candles.slice(offset, offset + 2_000).map((candle) => ({
        id: randomUUID(), stockId: stock.id, date: new Date(`${candle.date}T00:00:00.000Z`),
        open: candle.open, high: candle.high, low: candle.low, close: candle.close,
        adjustedClose: candle.adjustedClose, volume: candle.volume, source: "YAHOO",
        sourceSymbol: stock.yahooSymbol, providerMethod: "YAHOO_CHART_API",
        importedAt: new Date(), updatedAt: new Date(),
      })),
      skipDuplicates: true,
    });
    inserted += result.count;
  }
  const latest = candles.at(-1)!;
  await prisma.stock.update({ where: { id: stock.id }, data: { latestDate: new Date(`${latest.date}T00:00:00Z`), latestClose: latest.close, historyBackfilledAt: new Date() } });
  return inserted;
}

function errorReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 500);
  const code = typeof (error as Error & { code?: unknown }).code === "string" ? (error as Error & { code: string }).code : "NO_CODE";
  if (error.name === "PrismaClientValidationError") return `${error.name}:${code}`;
  const message = error.message.split("\n").map((line) => line.trim()).find(Boolean) ?? error.name;
  return `${error.name}:${code}:${message}`.slice(0, 500);
}

async function recordFailure(stock: Stock, error: unknown): Promise<void> {
  const message = errorReason(error);
  const permanent = /YAHOO_(HTTP_404|HTTP_422|NO_DATA|NO_VALID_CANDLES|INSUFFICIENT_HISTORY)/.test(message);
  await prisma.productionSchedulerFailure.upsert({
    where: { jobId_stockId: { jobId: JOB_ID, stockId: stock.id } },
    create: { jobId: JOB_ID, stockId: stock.id, symbol: stock.yahooSymbol, lastError: message, errorType: "YAHOO_HISTORICAL", classification: permanent ? "PARTIAL_SOURCE_DATA" : "RETRYABLE_FAILURE", resolved: false },
    update: { symbol: stock.yahooSymbol, lastError: message, errorType: "YAHOO_HISTORICAL", classification: permanent ? "PARTIAL_SOURCE_DATA" : "RETRYABLE_FAILURE", resolved: false, attempts: { increment: 1 }, lastAttemptedAt: new Date() },
  });
}

async function findMissingStocks(afterTicker: string | null | undefined, limit: number): Promise<Stock[]> {
  return prisma.$queryRawUnsafe<Stock[]>(
    `SELECT stock.id, stock.ticker, stock.yahoo_symbol AS "yahooSymbol", stock.company_name AS "companyName", stock.exchange, stock.is_active AS "isActive"
       FROM stocks stock
      WHERE stock.exchange = $1
        AND stock.is_active = TRUE
        AND stock.yahoo_symbol <> ''
        AND stock.ticker > $2
        AND ($4::text IS NULL OR stock.ticker ~ $4)
        AND ($5::boolean = FALSE OR (
          NOT EXISTS (SELECT 1 FROM etfs etf WHERE etf.exchange = 'SES' AND etf.code = stock.yahoo_symbol)
          AND NOT EXISTS (SELECT 1 FROM assets asset WHERE asset.asset_type::text IN ('ETF', 'FUND') AND asset.code = stock.yahoo_symbol)
          AND stock.company_name !~* '(fund|etf)'
        ))
        AND NOT EXISTS (SELECT 1 FROM stock_history history WHERE history.stock_id = stock.id OFFSET 4 LIMIT 1)
      ORDER BY stock.ticker ASC, stock.id ASC
      LIMIT $3`,
    MARKET,
    afterTicker ?? "",
    limit,
    MARKET_STOCK_REGEX[MARKET] ?? null,
    MARKET === "SES",
  );
}

async function main(): Promise<void> {
  console.log(`[GLOBAL_STOCK_HISTORICAL] MARKET=${MARKET} MODE=${DRY_RUN ? "DRY_RUN" : "RUN"} JOB_ID=${JOB_ID}`);
  await loadExplicitNonStockSymbols();
  const universe = await prisma.stock.findMany({ where: { ...stockScopeWhere(), yahooSymbol: { notIn: ["", ...EXCLUDED_NON_STOCK_SYMBOLS] } }, select: { id: true, ticker: true, yahooSymbol: true, companyName: true, exchange: true, isActive: true }, orderBy: [{ ticker: "asc" }, { id: "asc" }] });
  if (universe.length === 0 || universe.some((s) => !isWithinMarketStockScope(s))) throw new Error(`MARKET_SCOPE_UNCONFIRMED:${MARKET}`);
  const resume = await loadLifecycleResumeCheckpoint(prisma, JOB_ID);
  const resumeIndex = resume?.last_symbol ? universe.findIndex((s) => s.ticker === resume.last_symbol) : -1;
  const checkpointPrecedesScopedUniverse = Boolean(
    resume?.last_symbol && MARKET_STOCK_PREFIXES[MARKET] && resume.last_symbol < universe[0]!.ticker,
  );
  if (resume?.last_symbol && resumeIndex < 0 && !checkpointPrecedesScopedUniverse) throw new Error(`CHECKPOINT_OUTSIDE_MARKET_SCOPE:${resume.last_symbol}`);
  const missing = await findMissingStocks(resume?.last_symbol, MAX_SYMBOLS);
  const [ownLocks, ownRuns, daily] = await Promise.all([
    prisma.productionSchedulerLock.count({ where: { jobId: JOB_ID, expiresAt: { gt: new Date() } } }),
    prisma.productionSchedulerRun.count({ where: { jobId: JOB_ID, status: { in: ["RUNNING", "IN_PROGRESS", "PAUSE_REQUESTED"] } } }),
    dailyWriterState(),
  ]);
  const ready = ownLocks === 0 && ownRuns === 0 && daily.activeLocks === 0 && daily.activeRuns === 0 && missing.length > 0;
  console.log(JSON.stringify({ status: DRY_RUN ? (ready ? "DRY_RUN_READY" : "DRY_RUN_BLOCKED") : "PREFLIGHT_READY", market: MARKET, jobId: JOB_ID, universeCount: universe.length, excludedNonStockCount: EXCLUDED_NON_STOCK_SYMBOLS.size,
    plannedCount: missing.length, plannedSymbols: missing.map((s) => s.ticker), activeLockCount: ownLocks, activeRunCount: ownRuns, dailyJobId: DAILY_JOB_ID,
    dailyActiveLockCount: daily.activeLocks, dailyActiveRunCount: daily.activeRuns, checkpoint: resume ? { lastSymbol: resume.last_symbol, processed: resume.processed, succeeded: resume.succeeded, failed: resume.failed } : null, writesPerformed: false }, null, 2));
  if (DRY_RUN) { if (!ready) process.exitCode = 2; return; }
  if (process.env.LIVE_WRITE_AUTHORIZED !== "true") throw new Error("LIVE_WRITE_NOT_AUTHORIZED");
  if (!ready) throw new Error("PREFLIGHT_BLOCKED");

  const owner = `${process.env.SMARTFUND_NODE_ID ?? "local"}:${process.pid}`;
  const summary = createSummary();
  if (resume) Object.assign(summary, resume.details ?? { attempted: resume.processed, completed: resume.succeeded, success: resume.succeeded, failed: resume.failed });
  let runId: string | null = null, lockHeld = false, lastSymbol = resume?.last_symbol ?? null;
  try {
    await recoverOrphanedLifecycleRun(prisma, JOB_ID);
    lockHeld = await acquireLifecycleLock(prisma, JOB_ID, owner);
    if (!lockHeld) throw new Error(`ACTIVE_OWNER:${JOB_ID}`);
    runId = await createLifecycleRun(prisma, JOB_ID, MARKET, RUN_TYPE, { universeCount: universe.length });
    for (const stock of missing) {
      const collision = await dailyWriterState();
      if (collision.activeLocks || collision.activeRuns) {
        if (lastSymbol) await persistLifecycleCheckpoint(prisma, runId, summary, lastSymbol, { jobId: JOB_ID, runType: RUN_TYPE });
        await pauseLifecycleRun(prisma, runId);
        console.log(JSON.stringify({ status: "PAUSED_DAILY_COLLISION", checkpoint: lastSymbol, processed: summary.attempted })); return;
      }
      summary.attempted += 1;
      try {
        const payload = await fetchYahoo(stock); const archivePath = await archive(stock, payload.raw); const inserted = await insertCandles(stock, payload.candles);
        summary.completed += 1; summary.success += 1; summary.inserted += inserted; if (inserted === 0) summary.noUpdate += 1;
        await prisma.productionSchedulerFailure.deleteMany({ where: { jobId: JOB_ID, stockId: stock.id } });
        console.log(JSON.stringify({ market: MARKET, ticker: stock.ticker, status: "COMPLETE", candles: payload.candles.length, inserted, archivePath, processed: summary.attempted }));
      } catch (error) { summary.failed += 1; summary.retryableFailure += 1; await recordFailure(stock, error); console.error(JSON.stringify({ market: MARKET, ticker: stock.ticker, status: "FAILED", error: errorReason(error), processed: summary.attempted })); }
      lastSymbol = stock.ticker;
      if (summary.attempted % 5 === 0 || stock === missing.at(-1)) { await persistLifecycleCheckpoint(prisma, runId, summary, lastSymbol, { jobId: JOB_ID, runType: RUN_TYPE }); await heartbeatLifecycleLock(prisma, JOB_ID, owner); }
    }
    const hasRemaining = (await findMissingStocks(lastSymbol, 1)).length > 0;
    if (hasRemaining) { await pauseLifecycleRun(prisma, runId); console.log(JSON.stringify({ status: "PAUSED_CHECKPOINTED", market: MARKET, jobId: JOB_ID, remaining: "BOUNDED_SCAN_PENDING", checkpoint: lastSymbol, ...summary })); return; }
    const validation = { status: summary.completed + summary.failed === summary.attempted ? "PASS" : "FAIL", market: MARKET, universe: universe.length, processed: summary.attempted, remaining: 0 };
    await completeLifecycleRun(prisma, runId, summary, null, validation); console.log(JSON.stringify(validation));
  } catch (error) { if (runId) await failLifecycleRun(prisma, runId, error); throw error; }
  finally { if (lockHeld) await releaseLifecycleLock(prisma, JOB_ID, owner); }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
