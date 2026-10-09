import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "../../../lib/prisma.ts";
import { compareAssets, type CompareContract, type CompareRequestItem } from "../../../lib/data-platform/web/compareService.ts";

type WorkItem = { id: string; request: CompareContract; attempts?: number; sourceFile?: string };
type FailureClass = "TRANSIENT_NETWORK" | "AUTH" | "DATABASE_UNAVAILABLE" | "CONFIG" | "POOL" | "SSL" | "UNKNOWN_VERIFIED";

const root = process.cwd();
const runtime = join(root, "runtime", "compare");
const cacheDir = join(runtime, "cache");
const requestDir = join(runtime, "requests");
const processingDir = join(requestDir, "processing");
const config = JSON.parse(await readFile(join(root, "config", "compare-engine.json"), "utf8")) as {
  batchSize: number; pollIntervalMs: number; maxAttempts: number; maxConsecutiveDatabaseFailures: number; circuitOpenMs: number;
};
const daemon = process.argv.includes("--daemon");
const once = process.argv.includes("--once") || !daemon;
let stopping = false;
let consecutiveDatabaseFailures = 0;

const now = () => new Date().toISOString();
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = async <T>(path: string, fallback: T): Promise<T> => readFile(path, "utf8").then((text) => JSON.parse(text) as T).catch(() => fallback);
const writeJson = (path: string, value: unknown) => writeFile(path, json(value), "utf8");
const log = (event: string, payload: unknown = {}) => appendFile(join(runtime, "compare-engine.log"), `${now()} ${event} ${JSON.stringify(payload)}\n`);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function heartbeat(stage: string, extra: Record<string, unknown> = {}) {
  await writeJson(join(runtime, "heartbeat.json"), { status: stopping ? "STOPPING" : "RUNNING", pid: process.pid, stage, updatedAt: now(), consecutiveDatabaseFailures, ...extra });
}

function classify(error: unknown): FailureClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication|password|credential|P1000/i.test(message)) return "AUTH";
  if (/ssl|certificate|tls/i.test(message)) return "SSL";
  if (/pool|too many connections|P2024/i.test(message)) return "POOL";
  if (/DATABASE_URL|environment variable|P1012/i.test(message)) return "CONFIG";
  if (/Can't reach database|unavailable|P1001/i.test(message)) return "DATABASE_UNAVAILABLE";
  if (/timeout|network|ECONNRESET|ENOTFOUND/i.test(message)) return "TRANSIENT_NETWORK";
  return "UNKNOWN_VERIFIED";
}

async function boundedConnectivityCanary() {
  await prisma.$queryRawUnsafe("SELECT 1 AS ok");
  const [stock, etf, fund] = await Promise.all([
    prisma.stock.findFirst({ select: { id: true } }),
    prisma.etf.findFirst({ select: { id: true } }),
    prisma.fund.findFirst({ select: { id: true } }),
  ]);
  if (!stock || !etf || !fund) throw new Error("CANONICAL_CANARY_ENTITY_MISSING");
  return { stock: stock.id, etf: etf.id, fund: fund.id };
}

async function canaryContracts(): Promise<WorkItem[]> {
  const [stocks, etfs, funds] = await Promise.all([
    prisma.stock.findMany({ where: { isActive: true, latestClose: { not: null } }, select: { id: true, currency: true }, orderBy: { updatedAt: "desc" }, take: 10 }),
    prisma.etf.findMany({ where: { isActive: true, latestPrice: { not: null } }, select: { id: true, currency: true }, orderBy: { updatedAt: "desc" }, take: 10 }),
    prisma.fund.findMany({ where: { isActive: true, latestNav: { not: null } }, select: { id: true, currency: true }, orderBy: { updatedAt: "desc" }, take: 10 }),
  ]);
  const sameCurrencyPair = <T extends { id: string; currency: string }>(rows: T[]): CompareRequestItem[] | null => {
    for (const row of rows) { const match = rows.find((candidate) => candidate.id !== row.id && candidate.currency === row.currency); if (match) return [{ assetType: "STOCK", canonicalEntityId: row.id }, { assetType: "STOCK", canonicalEntityId: match.id }]; }
    return null;
  };
  const work: WorkItem[] = [];
  const stockPair = sameCurrencyPair(stocks);
  if (stockPair) work.push({ id: "canary-stock-1y", request: { items: stockPair, period: "1Y", alignmentPolicy: "EXACT_INTERSECTION", normalizationPolicy: "SAME_CURRENCY" } });
  if (stockPair) work.push({ id: "canary-stock-1m", request: { items: stockPair, period: "1M", alignmentPolicy: "EXACT_INTERSECTION", normalizationPolicy: "SAME_CURRENCY" } });
  if (etfs.length >= 2) work.push({ id: "canary-etf", request: { items: etfs.slice(0, 2).map((row) => ({ assetType: "ETF", canonicalEntityId: row.id })), period: "1Y", alignmentPolicy: "EXACT_INTERSECTION", normalizationPolicy: etfs[0].currency === etfs[1].currency ? "SAME_CURRENCY" : "NATIVE_NOT_NORMALIZED" } });
  if (funds.length >= 2) work.push({ id: "canary-fund", request: { items: funds.slice(0, 2).map((row) => ({ assetType: "FUND", canonicalEntityId: row.id })), period: "1Y", alignmentPolicy: "EXACT_INTERSECTION", normalizationPolicy: funds[0].currency === funds[1].currency ? "SAME_CURRENCY" : "NATIVE_NOT_NORMALIZED" } });
  if (stocks[0] && etfs[0]) work.push({ id: "canary-cross-asset", request: { items: [{ assetType: "STOCK", canonicalEntityId: stocks[0].id }, { assetType: "ETF", canonicalEntityId: etfs[0].id }], period: "1Y", alignmentPolicy: "EXACT_INTERSECTION", normalizationPolicy: "NATIVE_NOT_NORMALIZED" } });
  return work.slice(0, config.batchSize);
}

async function dequeue(): Promise<WorkItem[]> {
  const files = (await readdir(requestDir).catch(() => [])).filter((file) => file.endsWith(".json")).slice(0, config.batchSize);
  const work: WorkItem[] = [];
  for (const file of files) {
    const source = join(requestDir, file);
    const target = join(processingDir, file);
    await rename(source, target);
    work.push({ id: file.replace(/\.json$/, ""), request: await readJson<CompareContract>(target, null as never), sourceFile: target });
  }
  return work.length ? work : canaryContracts();
}

async function recordFailure(item: WorkItem, error: unknown) {
  const attempts = (item.attempts ?? 0) + 1;
  const entry = { ...item, sourceFile: undefined, attempts, failureClass: classify(error), lastError: error instanceof Error ? error.message : String(error), lastAttemptAt: now() };
  const target = attempts >= config.maxAttempts ? "dead-letter.json" : "failure-queue.json";
  const queue = await readJson<unknown[]>(join(runtime, target), []);
  queue.push(entry);
  await writeJson(join(runtime, target), queue);
}

async function processCycle() {
  await heartbeat("CONNECTIVITY_CANARY");
  const connectivity = await boundedConnectivityCanary();
  consecutiveDatabaseFailures = 0;
  await log("CONNECTIVITY_PASS", { canonicalRead: { stock: !!connectivity.stock, etf: !!connectivity.etf, fund: !!connectivity.fund } });
  const work = await dequeue();
  let succeeded = 0;
  let failed = 0;
  for (let index = 0; index < work.length; index++) {
    const item = work[index];
    await heartbeat("CALCULATING", { currentScope: item.id, batchIndex: index, batchSize: work.length });
    try {
      const snapshot = await compareAssets(item.request);
      const cachePath = join(cacheDir, `${snapshot.meta.requestHash}.json`);
      const existing = await readJson<{ meta?: { upstreamWatermarks?: unknown } } | null>(cachePath, null);
      const cacheStatus = existing && JSON.stringify(existing.meta?.upstreamWatermarks) === JSON.stringify(snapshot.meta.upstreamWatermarks) ? "CACHE_HIT_CURRENT" : "CACHE_REFRESHED";
      if (cacheStatus === "CACHE_REFRESHED") await writeJson(cachePath, snapshot);
      if (item.sourceFile) await rename(item.sourceFile, `${item.sourceFile}.completed`);
      succeeded++;
      await log("SNAPSHOT_COMPLETE", { scope: item.id, snapshotId: snapshot.meta.snapshotId, cacheStatus, qualityStatus: snapshot.meta.qualityStatus });
    } catch (error) {
      failed++;
      await recordFailure(item, error);
      if (item.sourceFile) await rename(item.sourceFile, `${item.sourceFile}.failed`).catch(() => undefined);
      await log("SNAPSHOT_FAILED", { scope: item.id, failureClass: classify(error), error: error instanceof Error ? error.message : String(error) });
    }
    await writeJson(join(runtime, "checkpoint.json"), { version: 2, status: "RUNNING", cursor: index + 1, processed: index + 1, succeeded, failed, currentScope: item.id, updatedAt: now() });
  }
  const manifest = await readJson<{ runs: unknown[] }>(join(runtime, "completion-manifest.json"), { runs: [] });
  await writeJson(join(runtime, "completion-manifest.json"), { status: failed ? "COMPLETED_WITH_FAILURES" : "COMPLETED", runs: [...manifest.runs.slice(-99), { completedAt: now(), attempted: work.length, succeeded, failed }], updatedAt: now() });
  await writeJson(join(runtime, "checkpoint.json"), { version: 2, status: failed ? "COMPLETED_WITH_FAILURES" : "COMPLETED", cursor: work.length, processed: work.length, succeeded, failed, currentScope: null, updatedAt: now() });
  await heartbeat("IDLE", { lastCycle: { attempted: work.length, succeeded, failed } });
}

async function main() {
  await Promise.all([mkdir(cacheDir, { recursive: true }), mkdir(processingDir, { recursive: true })]);
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  await log("ENGINE_START", { pid: process.pid, daemon, canonicalCompareOwner: "lib/data-platform/web/compareService.ts" });
  do {
    try {
      await processCycle();
    } catch (error) {
      consecutiveDatabaseFailures++;
      const failureClass = classify(error);
      if (consecutiveDatabaseFailures >= config.maxConsecutiveDatabaseFailures) {
        const nextRetryTime = new Date(Date.now() + config.circuitOpenMs).toISOString();
        await heartbeat("CIRCUIT_OPEN", { failureClass, nextRetryTime });
        await log("CIRCUIT_OPEN", { failureClass, consecutiveDatabaseFailures, nextRetryTime });
        if (once) break;
        await sleep(config.circuitOpenMs);
      } else {
        const backoffMs = Math.min(60_000, 5_000 * 2 ** (consecutiveDatabaseFailures - 1));
        await heartbeat("DATABASE_BACKOFF", { failureClass, backoffMs, nextRetryTime: new Date(Date.now() + backoffMs).toISOString() });
        await log("DATABASE_UNHEALTHY", { failureClass, consecutiveDatabaseFailures, backoffMs });
        if (once) break;
        await sleep(backoffMs);
      }
      continue;
    }
    if (!once && !stopping) await sleep(config.pollIntervalMs);
  } while (!once && !stopping);
  await writeJson(join(runtime, "heartbeat.json"), { status: "STOPPED", pid: process.pid, stage: "STOPPED", updatedAt: now(), consecutiveDatabaseFailures });
  await prisma.$disconnect();
}

main().catch(async (error) => {
  await log("ENGINE_FATAL", { failureClass: classify(error), error: error instanceof Error ? error.stack : String(error) });
  await writeJson(join(runtime, "heartbeat.json"), { status: "FAILED", pid: process.pid, stage: "FATAL", updatedAt: now() });
  await prisma.$disconnect();
  process.exitCode = 1;
});
