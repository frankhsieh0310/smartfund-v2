import { mkdir, open, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { fetchYahooChartPeriod } from "../../../lib/services/dataProviders/yahoo/yahooClient.ts";
import { writeAssetRuntimeStatus } from "../../../lib/data-platform/runtime/writeAssetRuntimeStatus.ts";

const prisma = new PrismaClient();
const runtime = join(process.cwd(), "runtime", "global-etf");
const checkpointPath = join(runtime, "checkpoint.json");
const heartbeatPath = join(runtime, "heartbeat.json");
const completionPath = join(runtime, "completion-manifest.json");
const failurePath = join(runtime, "failure-queue.json");
const lockPath = join(runtime, "single-writer.lock");
let lock: FileHandle | null = null;
let ownsLock = false;
const requestedSymbols = (process.argv.find((value) => value.startsWith("--symbols="))?.slice(10) ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const MAX_ATTEMPTS = 3;

type Status = "CURRENT" | "UPDATED" | "SOURCE_FAILURE" | "SYMBOL_MAPPING" | "PARSE_FAILURE" | "WRITE_FAILURE";
type CheckpointItem = {
  market: string;
  symbol: string;
  lastDbDate: string | null;
  lastSourceDate: string | null;
  status: Status;
  lastSuccessfulRun: string | null;
  nextResumePosition: number;
};
type Checkpoint = { asset: "GLOBAL_ETF"; updatedAt: string; nextResumePosition: number; items: Record<string, CheckpointItem> };
type Failure = { key: string; symbol: string; category: Exclude<Status, "CURRENT" | "UPDATED">; message: string; attempts: number; lastAttemptAt: string };

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const utcDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readJson<T>(path: string, fallback: T): Promise<T> {
  return readFile(path, "utf8").then((value) => JSON.parse(value) as T).catch(() => fallback);
}

async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  checkpoint.updatedAt = new Date().toISOString();
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function saveHeartbeat(stage: string, extra: object = {}): Promise<void> {
  await writeFile(heartbeatPath, `${JSON.stringify({ asset: "GLOBAL_ETF", pid: process.pid, processAlive: true, stage, latestPath: true, incremental: true, scheduler: "ACTIVE", autoContinuing: true, at: new Date().toISOString(), ...extra }, null, 2)}\n`);
}

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function acquireSingleWriter(): Promise<void> {
  await mkdir(runtime, { recursive: true });
  try { lock = await open(lockPath, "wx"); }
  catch {
    const owner = await readJson<{ pid?: number }>(lockPath, {});
    if (owner.pid && processAlive(owner.pid)) throw new Error(`GLOBAL_ETF_SINGLE_WRITER_ACTIVE:${owner.pid}`);
    await rm(lockPath, { force: true });
    lock = await open(lockPath, "wx");
  }
  await lock.writeFile(`${JSON.stringify({ pid: process.pid, owner: "GLOBAL_ETF_LATEST", acquiredAt: new Date().toISOString() })}\n`);
  ownsLock = true;
}
async function releaseSingleWriter(): Promise<void> {
  if (!ownsLock) return;
  if (lock) await lock.close().catch(() => undefined);
  lock = null;
  ownsLock = false;
  await rm(lockPath, { force: true }).catch(() => undefined);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void releaseSingleWriter().finally(() => process.exit(0));
});

async function publishRuntimeStatus(input: { runState: "RUNNING" | "SCHEDULED_WAIT" | "BLOCKED" | "COMPLETE"; market?: string | null; processed: number; total: number; checkpoint?: string | null; source?: string | null; progress?: string; nextRunAt?: string | null; blocker?: string | null }): Promise<void> {
  await writeAssetRuntimeStatus({
    ASSET: "ETF",
    CURRENT_PHASE: "CONTINUOUS_DEPTH",
    CURRENT_LAYER: "L3_PRICE_HISTORY",
    CURRENT_TASK: "PRICE_HISTORY_INCREMENTAL",
    CURRENT_MARKET: input.market ?? null,
    PROCESSED: input.processed,
    TOTAL: input.total,
    COVERAGE: input.total ? `${input.processed}/${input.total} (${((input.processed / input.total) * 100).toFixed(2)}%)` : null,
    RUN_STATE: input.runState,
    PROCESS_ID: input.runState === "RUNNING" ? process.pid : null,
    CHECKPOINT: input.checkpoint ?? null,
    SOURCE: input.source ?? null,
    BLOCKER: input.blocker ?? null,
    NEXT: input.runState === "RUNNING" ? "CONTINUE_CURRENT_BATCH" : "NEXT_SCHEDULED_INCREMENTAL_CYCLE",
    NEXT_RUN_AT: input.nextRunAt ?? null,
    QUOTE_STATUS: "NOT_READY",
    CONTINUING: input.runState === "COMPLETE" || input.runState === "BLOCKED" ? "NO" : "YES",
    LAST_PROGRESS: input.progress,
    progressChanged: Boolean(input.progress),
  });
}

function classify(error: unknown): Failure["category"] {
  const message = error instanceof Error ? error.message : String(error);
  if (/SOURCE_|HTTP|fetch|timeout/i.test(message)) return "SOURCE_FAILURE";
  if (/SYMBOL|IDENTITY/i.test(message)) return "SYMBOL_MAPPING";
  if (/PARSE|EMPTY|CANDLE/i.test(message)) return "PARSE_FAILURE";
  return "WRITE_FAILURE";
}

async function recordFailure(symbol: string, error: unknown): Promise<void> {
  const failures = await readJson<Failure[]>(failurePath, []);
  const category = classify(error);
  const key = `${symbol}:${category}`;
  const message = error instanceof Error ? error.message : String(error);
  const existing = failures.find((failure) => failure.key === key);
  if (existing) Object.assign(existing, { message, attempts: existing.attempts + 1, lastAttemptAt: new Date().toISOString() });
  else failures.push({ key, symbol, category, message, attempts: 1, lastAttemptAt: new Date().toISOString() });
  await writeFile(failurePath, `${JSON.stringify(failures.slice(-100), null, 2)}\n`);
}

async function main(): Promise<void> {
  await acquireSingleWriter();
  const checkpoint = await readJson<Checkpoint>(checkpointPath, { asset: "GLOBAL_ETF", updatedAt: new Date().toISOString(), nextResumePosition: 0, items: {} });
  const universe = await prisma.etf.findMany({
    where: {
      isActive: true,
      dataProvider: { equals: "yahoo-finance", mode: "insensitive" },
      dataSource: { not: null },
      currency: { not: "TWD" },
      NOT: [{ exchange: { in: ["TWSE", "TPEx", "TPEX", "TW"] } }],
      ...(requestedSymbols.length ? { code: { in: requestedSymbols } } : {}),
    },
    orderBy: [{ exchange: "asc" }, { code: "asc" }],
    select: { id: true, code: true, exchange: true, dataSource: true },
  });
  const start = requestedSymbols.length ? 0 : Math.min(checkpoint.nextResumePosition, Math.max(0, universe.length - 1));
  const ordered = [...universe.slice(start), ...universe.slice(0, start)];
  const summary = { asset: "GLOBAL_ETF", universeCount: universe.length, attempted: 0, current: 0, updated: 0, failed: 0, startedAt: new Date().toISOString() };
  await saveHeartbeat("INCREMENTAL", { universeCount: universe.length });
  await publishRuntimeStatus({ runState: "RUNNING", processed: 0, total: universe.length });

  for (const etf of ordered) {
    summary.attempted += 1;
    const symbol = etf.dataSource?.trim();
    const market = etf.exchange ?? "UNKNOWN";
    const position = universe.findIndex((item) => item.id === etf.id);
    if (!symbol) {
      const error = new Error("SYMBOL_MAPPING_MISSING");
      await recordFailure(etf.code, error);
      summary.failed += 1;
      continue;
    }
    try {
      const latest = await prisma.etfHistory.findFirst({ where: { etfId: etf.id, price: { not: null } }, orderBy: { date: "desc" }, select: { date: true } });
      const from = latest ? new Date(latest.date.getTime() - 3 * 86_400_000) : new Date(Date.now() - 30 * 86_400_000);
      let chart = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        chart = await fetchYahooChartPeriod(symbol, Math.floor(from.getTime() / 1_000), Math.floor((Date.now() + 86_400_000) / 1_000));
        if (chart?.candles.length) break;
        if (attempt < MAX_ATTEMPTS) await delay(15_000);
      }
      if (!chart) throw new Error("SOURCE_FETCH_EMPTY");
      const valid = chart.candles.filter((row) => row.close !== null && Number.isFinite(row.close) && row.close! > 0);
      const sourceLatest = valid.at(-1);
      if (!sourceLatest) throw new Error("PARSE_NO_VALID_CANDLE");
      const dbLatest = latest ? isoDate(latest.date) : null;
      const sourceLatestDate = isoDate(sourceLatest.date);
      let status: Status = "CURRENT";
      let addedRows = 0;
      const changed = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM etfs WHERE id = ${etf.id} FOR UPDATE`;
        const current = await tx.etfHistory.findFirst({ where: { etfId: etf.id, price: { not: null } }, orderBy: { date: "desc" } });
        if (current && isoDate(current.date) > sourceLatestDate) return false;
        // Compare at the existing price column's precision. This job only writes
        // the source's latest observation; historical gaps have separate owners.
        const price = Number(sourceLatest.close!.toFixed(4));
        const master = await tx.etf.findUniqueOrThrow({ where: { id: etf.id }, select: { latestPrice: true } });
        const volume = sourceLatest.volume == null ? undefined : sourceLatest.volume;
        const historyChanged = !current || isoDate(current.date) !== sourceLatestDate
          || Number(current.price) !== price || (volume !== undefined && (current.volume == null || Number(current.volume) !== volume));
        const masterChanged = master.latestPrice == null || Number(master.latestPrice) !== price;
        if (!historyChanged && !masterChanged) return false;
        if (historyChanged) await tx.etfHistory.upsert({
          where: { etfId_date: { etfId: etf.id, date: utcDate(sourceLatestDate) } },
          create: { etfId: etf.id, date: utcDate(sourceLatestDate), price, volume },
          update: { price, volume },
        });
        if (historyChanged || masterChanged) await tx.etf.update({ where: { id: etf.id }, data: { latestPrice: price, priceUpdatedAt: new Date() } });
        return true;
      });
      if (changed) {
        addedRows = 1;
        status = "UPDATED";
        summary.updated += 1;
      } else summary.current += 1;
      checkpoint.items[etf.code] = { market, symbol, lastDbDate: sourceLatestDate, lastSourceDate: sourceLatestDate, status, lastSuccessfulRun: new Date().toISOString(), nextResumePosition: (position + 1) % Math.max(1, universe.length) };
      checkpoint.nextResumePosition = checkpoint.items[etf.code].nextResumePosition;
      await saveCheckpoint(checkpoint);
      await saveHeartbeat("INCREMENTAL", { currentSymbol: etf.code, checkpointAdvancing: true, lastDbDate: sourceLatestDate, lastSourceDate: sourceLatestDate });
      await publishRuntimeStatus({ runState: "RUNNING", market, processed: summary.attempted, total: universe.length, checkpoint: etf.code, source: "YAHOO_CHART", progress: status === "UPDATED" ? `${market} Price History: ${etf.code} added ${addedRows} daily row(s); ${summary.attempted}/${universe.length} processed` : `${market} Price History: checkpoint advanced to ${etf.code}; source current through ${sourceLatestDate}; ${summary.attempted}/${universe.length} processed` });
    } catch (error) {
      summary.failed += 1;
      const category = classify(error);
      checkpoint.items[etf.code] = { market, symbol, lastDbDate: null, lastSourceDate: null, status: category, lastSuccessfulRun: null, nextResumePosition: (position + 1) % Math.max(1, universe.length) };
      checkpoint.nextResumePosition = checkpoint.items[etf.code].nextResumePosition;
      await Promise.all([saveCheckpoint(checkpoint), recordFailure(etf.code, error)]);
      await publishRuntimeStatus({ runState: "RUNNING", market, processed: summary.attempted, total: universe.length, checkpoint: etf.code, source: "YAHOO_CHART", progress: `${market} Price History: ${etf.code} classified ${category}; checkpoint advanced to ${summary.attempted}/${universe.length}` });
    }
  }
  const completedAt = new Date().toISOString();
  await writeFile(completionPath, `${JSON.stringify({ ...summary, completedAt, latestPath: true, incremental: true, checkpointActive: true, singleWriter: true, status: summary.failed ? "CATCHING_UP" : "WAITING_FOR_NEXT_UPDATE" }, null, 2)}\n`);
  await saveHeartbeat("WAITING_FOR_NEXT_UPDATE", { checkpointAdvancing: true, lastCycleCompletedAt: completedAt });
  await publishRuntimeStatus({ runState: "SCHEDULED_WAIT", processed: summary.attempted, total: universe.length, checkpoint: ordered.at(-1)?.code ?? null, source: "YAHOO_CHART", progress: `Price History cycle completed: ${summary.updated} updated, ${summary.current} current, ${summary.failed} failed`, nextRunAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() });
}

main().catch(async (error) => {
  if (String(error).includes("GLOBAL_ETF_SINGLE_WRITER_ACTIVE")) { console.error(error); process.exitCode = 1; return; }
  await saveHeartbeat("CYCLE_FAILED", { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
  await publishRuntimeStatus({ runState: "BLOCKED", processed: 0, total: 0, blocker: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
  process.exitCode = 1;
}).finally(async () => { await prisma.$disconnect(); await releaseSingleWriter(); });
