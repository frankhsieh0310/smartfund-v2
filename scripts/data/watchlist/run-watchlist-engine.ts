import { appendFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";

type AssetType = "STOCK" | "ETF" | "FUND" | "BOND" | "COMMODITY" | "FX" | "CRYPTO" | "INDEX" | "REIT";
type AlertKind = "ABOVE" | "BELOW" | "PERCENT_CHANGE" | "NEW_HIGH" | "NEW_LOW" | "EARNINGS" | "DIVIDEND" | "CORPORATE_ACTION" | "IPO" | "ETF_HOLDINGS_CHANGE" | "CENTRAL_BANK_DECISION" | "ECONOMIC_CALENDAR" | "ALLOCATION_DRIFT" | "WEIGHT_CHANGE" | "CONCENTRATION";
type WatchItem = { assetType: AssetType; assetId: string };
type Watchlist = { id: string; enabled?: boolean; items: WatchItem[] };
type AlertRule = { id: string; watchlistId: string; kind: AlertKind; enabled?: boolean; assetId?: string; threshold?: number; lookback?: number; eventTypes?: string[]; cooldownMinutes?: number };
type Registry = { version: number; watchlists: Watchlist[]; alerts: AlertRule[] };
type FeedRecord = { id?: string; assetType?: AssetType; assetId?: string; observedAt?: string; price?: number; previousClose?: number; high?: number; low?: number; volume?: number; eventType?: string; eventId?: string; eventAt?: string; portfolioId?: string; weight?: number; previousWeight?: number; targetWeight?: number };
type Checkpoint = { version: 1; files: Record<string, { size: number; mtimeMs: number }>; emitted: Record<string, string>; updatedAt: string };
type Config = { pollIntervalMs: number; maxAttempts: number; retryBaseDelayMs: number; supportedAssets: AssetType[]; input: { feedDirectory: string; networkAccess: boolean }; storage: Record<string, string> };

const root = process.cwd();
const configPath = resolve(root, "config/watchlist-alert-engine.json");
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

async function json<T>(path: string, fallback?: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if (fallback !== undefined) return fallback; throw error; }
}

async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

async function appendJsonl(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function absolute(path: string) { return resolve(root, path); }

function validateRegistry(registry: Registry, config: Config) {
  const watchlists = new Set(registry.watchlists.map((item) => item.id));
  if (watchlists.size !== registry.watchlists.length) throw new Error("Duplicate watchlist id");
  for (const list of registry.watchlists) for (const item of list.items) {
    if (!config.supportedAssets.includes(item.assetType)) throw new Error(`Unsupported asset: ${item.assetType}`);
    if (!item.assetId) throw new Error(`Missing assetId in watchlist ${list.id}`);
  }
  for (const alert of registry.alerts) if (!watchlists.has(alert.watchlistId)) throw new Error(`Unknown watchlist: ${alert.watchlistId}`);
}

async function readFeed(path: string): Promise<FeedRecord[]> {
  const raw = await readFile(path, "utf8");
  if (extname(path) === ".jsonl") return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : Array.isArray(parsed.records) ? parsed.records : [parsed];
}

function matches(rule: AlertRule, record: FeedRecord, watched: Set<string>) {
  if (rule.enabled === false) return false;
  const identity = record.assetType && record.assetId ? `${record.assetType}:${record.assetId}` : undefined;
  if (rule.assetId && record.assetId !== rule.assetId) return false;
  if (identity && !watched.has(identity) && !record.portfolioId) return false;
  switch (rule.kind) {
    case "ABOVE": return record.price !== undefined && record.price > Number(rule.threshold);
    case "BELOW": return record.price !== undefined && record.price < Number(rule.threshold);
    case "PERCENT_CHANGE": return record.price !== undefined && record.previousClose !== undefined && record.previousClose !== 0 && Math.abs((record.price / record.previousClose - 1) * 100) >= Number(rule.threshold);
    case "NEW_HIGH": return record.price !== undefined && record.high !== undefined && record.price >= record.high;
    case "NEW_LOW": return record.price !== undefined && record.low !== undefined && record.price <= record.low;
    case "ALLOCATION_DRIFT": return record.weight !== undefined && record.targetWeight !== undefined && Math.abs(record.weight - record.targetWeight) >= Number(rule.threshold);
    case "WEIGHT_CHANGE": return record.weight !== undefined && record.previousWeight !== undefined && Math.abs(record.weight - record.previousWeight) >= Number(rule.threshold);
    case "CONCENTRATION": return record.weight !== undefined && record.weight >= Number(rule.threshold);
    default: return record.eventType === rule.kind || Boolean(rule.eventTypes?.includes(record.eventType ?? ""));
  }
}

async function acquireLock(path: string) {
  await mkdir(dirname(path), { recursive: true });
  try { return await open(path, "wx"); }
  catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    const lock = await stat(path).catch(() => undefined);
    if (lock && Date.now() - lock.mtimeMs > 120000) { await rename(path, `${path}.stale-${Date.now()}`); return open(path, "wx"); }
    throw new Error("Watchlist engine is already running");
  }
}

async function main() {
  const config = await json<Config>(configPath);
  if (config.input.networkAccess !== false) throw new Error("networkAccess must remain false");
  for (const path of Object.values(config.storage)) await mkdir(dirname(absolute(path)), { recursive: true });
  await mkdir(absolute(config.input.feedDirectory), { recursive: true });
  await mkdir(absolute(config.storage.archive), { recursive: true });
  const lockPath = absolute("runtime/watchlist/watchlist-engine.lock");
  const lock = await acquireLock(lockPath);
  await lock.writeFile(`${process.pid}\n`);
  const log = async (stage: string, detail: Record<string, unknown> = {}) => appendJsonl(absolute(config.storage.log), { at: now(), pid: process.pid, stage, ...detail });
  const once = process.argv.includes("--once");
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  try {
    await log("STANDALONE_RUNNING", { inputMode: "EXISTING_DATA_ONLY" });
    do {
      const startedAt = now();
      let processedFiles = 0, evaluatedRecords = 0, queuedAlerts = 0, failures = 0;
      const registry = await json<Registry>(absolute(config.storage.registry));
      validateRegistry(registry, config);
      const checkpoint = await json<Checkpoint>(absolute(config.storage.checkpoint), { version: 1, files: {}, emitted: {}, updatedAt: startedAt });
      const entries = (await readdir(absolute(config.input.feedDirectory), { withFileTypes: true })).filter((entry) => entry.isFile() && [".json", ".jsonl"].includes(extname(entry.name))).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const feedPath = join(absolute(config.input.feedDirectory), entry.name);
        const info = await stat(feedPath);
        const prior = checkpoint.files[entry.name];
        if (prior?.size === info.size && prior?.mtimeMs === info.mtimeMs) continue;
        try {
          const records = await readFeed(feedPath);
          for (const record of records) {
            evaluatedRecords++;
            for (const list of registry.watchlists.filter((item) => item.enabled !== false)) {
              const watched = new Set(list.items.map((item) => `${item.assetType}:${item.assetId}`));
              for (const rule of registry.alerts.filter((item) => item.watchlistId === list.id)) {
                if (!matches(rule, record, watched)) continue;
                const observed = record.observedAt ?? record.eventAt ?? startedAt;
                const dedupeKey = hash([rule.id, record.eventId ?? record.id ?? record.assetId ?? record.portfolioId, observed, record.price, record.weight]);
                const previous = checkpoint.emitted[dedupeKey];
                const cooldown = (rule.cooldownMinutes ?? 0) * 60000;
                if (previous && Date.now() - Date.parse(previous) < cooldown) continue;
                await appendJsonl(absolute(config.storage.queue), { id: dedupeKey, status: "PENDING", createdAt: now(), ruleId: rule.id, watchlistId: list.id, kind: rule.kind, assetType: record.assetType, assetId: record.assetId, portfolioId: record.portfolioId, observedAt: observed, payload: record });
                checkpoint.emitted[dedupeKey] = now();
                queuedAlerts++;
              }
            }
          }
          checkpoint.files[entry.name] = { size: info.size, mtimeMs: info.mtimeMs };
          processedFiles++;
        } catch (error: any) {
          failures++;
          await appendJsonl(absolute(config.storage.retry), { file: entry.name, failedAt: now(), attempt: 1, retryAfter: new Date(Date.now() + config.retryBaseDelayMs).toISOString(), maxAttempts: config.maxAttempts, error: String(error?.message ?? error) });
          await log("FEED_FAILED", { file: entry.name, error: String(error?.message ?? error) });
        }
      }
      checkpoint.updatedAt = now();
      await atomicJson(absolute(config.storage.checkpoint), checkpoint);
      await atomicJson(absolute(config.storage.completionManifest), { asset: "GLOBAL_WATCHLIST_ALERT_ENGINE", version: 1, cycleStartedAt: startedAt, cycleCompletedAt: now(), pid: process.pid, inputMode: "EXISTING_DATA_ONLY", processedFiles, evaluatedRecords, queuedAlerts, failures, status: failures ? "COMPLETED_WITH_RETRY" : "COMPLETED" });
      await log("CYCLE_COMPLETED", { processedFiles, evaluatedRecords, queuedAlerts, failures });
      if (!once && !stopping) await sleep(config.pollIntervalMs);
    } while (!once && !stopping);
    await log("STOPPED");
  } finally {
    await lock.close();
    await rename(lockPath, `${absolute(config.storage.archive)}/watchlist-engine-${Date.now()}.lock`).catch(() => undefined);
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await appendFile(resolve(root, "runtime/watchlist/watchlist-engine.log"), `${JSON.stringify({ at: now(), pid: process.pid, stage: "FATAL", error: message })}\n`).catch(() => undefined);
  process.exitCode = 1;
});
