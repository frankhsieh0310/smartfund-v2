import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runtime = join(root, "runtime", "margin-short");
const canonicalRuntime = join(root, "runtime", "securities-lending");
const checkpointPath = join(runtime, "checkpoint.json");
const heartbeatPath = join(runtime, "heartbeat.json");
const manifestPath = join(runtime, "completion-manifest.json");
const logPath = join(runtime, "margin-short.log");
const registryPath = join(root, "config", "margin-short-official-registry.json");
const schedulerPath = join(root, "config", "margin-short-scheduler.json");
const canaryOnly = process.argv.includes("--canary");

await Promise.all(["archive", "data", "failure-queue"].map((name) => mkdir(join(runtime, name), { recursive: true })));

async function json(path: string, fallback: any = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}
async function atomic(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, path);
}
async function log(message: string) { await appendFile(logPath, `${new Date().toISOString()} pid=${process.pid} ${message}\n`); }
async function state(stage: string, scope: string, extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  await atomic(checkpointPath, { asset: "GLOBAL_MARGIN_SHORT_STATISTICS", pid: process.pid, processAlive: true, stage, scope, updatedAt: now, ...extra });
  await atomic(heartbeatPath, { pid: process.pid, processAlive: true, stage, scope, at: now });
}

const registry = await json(registryPath);
const scheduler = await json(schedulerPath, { incrementalIntervalMinutes: 1440 });
const canonicalCheckpointPath = join(canonicalRuntime, "checkpoint.json");
const canonicalManifestPath = join(canonicalRuntime, "completion-manifest.json");

async function canary() {
  await state("CANARY", "official-registry");
  const canonicalCheckpoint = await json(canonicalCheckpointPath);
  const canonicalManifest = await json(canonicalManifestPath);
  if (!registry?.sources?.length) throw new Error("EMPTY_OFFICIAL_REGISTRY");
  if (!canonicalCheckpoint || !canonicalManifest) throw new Error("SECURITIES_LENDING_CANONICAL_UNAVAILABLE");
  const result = { status: "PASS", checkedAt: new Date().toISOString(), officialSources: registry.sources.length, canonicalAsset: canonicalCheckpoint.asset, canonicalCheckpoint: relative(root, canonicalCheckpointPath), canonicalManifest: relative(root, canonicalManifestPath) };
  await atomic(join(runtime, "canary-result.json"), result);
  await log(`canary-pass sources=${registry.sources.length} reused=GLOBAL_SECURITIES_LENDING`);
  return result;
}

async function cycle() {
  const previous = await json(checkpointPath, {});
  const stages = previous.historicalCompletedAt ? ["LATEST", "INCREMENTAL"] : ["HISTORICAL", "LATEST", "INCREMENTAL"];
  const canonicalCheckpoint = await json(canonicalCheckpointPath);
  const canonicalManifest = await json(canonicalManifestPath);
  const sources = [];
  for (const stage of stages) {
    for (const source of registry.sources) {
      await state(stage, `${source.id}:${source.level}`);
      sources.push({ source: source.id, stage, status: "REUSED_CANONICAL", canonicalAsset: "GLOBAL_SECURITIES_LENDING", datasets: source.datasets, level: source.level });
    }
  }
  const now = new Date().toISOString();
  await state("ARCHIVE", "completion-manifest");
  await atomic(manifestPath, { asset: "GLOBAL_MARGIN_SHORT_STATISTICS", completedAt: now, stages, separation: { marketLevel: "level=market_and_security (aggregate records)", securityLevel: "level=security or security records within market_and_security" }, reusedCanonical: { asset: "GLOBAL_SECURITIES_LENDING", checkpoint: relative(root, canonicalCheckpointPath), manifest: relative(root, canonicalManifestPath), canonicalUpdatedAt: canonicalCheckpoint?.updatedAt, canonicalCompletedAt: canonicalManifest?.completedAt }, sources });
  await atomic(join(runtime, "archive", `${now.replaceAll(":", "-")}-canonical-reference.json`), { canonicalCheckpoint, canonicalManifest });
  await state("SCHEDULED", "incremental", { historicalCompletedAt: previous.historicalCompletedAt ?? now, latestCompletedAt: now, incrementalCompletedAt: now, nextRunAt: new Date(Date.now() + scheduler.incrementalIntervalMinutes * 60_000).toISOString() });
  await log(`cycle-complete stages=${stages.join(",")} reused=GLOBAL_SECURITIES_LENDING`);
}

process.on("SIGTERM", async () => { await state("STOPPED", "signal", { processAlive: false }); process.exit(0); });
await log("runner-started");
await canary();
if (canaryOnly) process.exit(0);
for (;;) {
  await cycle();
  await new Promise((resolve) => setTimeout(resolve, scheduler.incrementalIntervalMinutes * 60_000));
}
