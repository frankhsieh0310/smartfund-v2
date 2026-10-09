import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeAssetRuntimeStatus } from "../../../lib/data-platform/runtime/writeAssetRuntimeStatus.ts";

type Priority = "P0A" | "P0B" | "P1";
type CapabilityStatus = "CURRENT_AND_AUTO_UPDATING" | "MAX_SOURCE_DEPTH_REACHED" | "SOURCE_CONSTRAINED" | "ACCESS_CONSTRAINED" | "LICENSE_CONSTRAINED" | "TIME_DEPTH_CONSTRAINED" | "INPUT_CONSTRAINED" | "MAPPING_CONSTRAINED";
type Domain = { id: string; runtime: string; checkpoint: string; priority: Priority };
type Capability = { id: string; priority: Priority; status: CapabilityStatus };
type Config = { version: number; asset: string; task: string; pollIntervalMs: number; domains: Domain[]; capabilities: Capability[]; futuresBoundary: object };
type GapState = "PENDING" | "RUNNING" | "RETRY_WAIT" | "BLOCKED" | "COMPLETE";
type GapItem = { gap_id: string; priority: string; domain: string; worker: string; work_type: string; state: GapState; checkpoint: string | null; attempts: number; started_at?: string | null; updated_at?: string | null; completed_at?: string | null; last_error?: string | null; next_retry_at?: string | null };
type GapQueue = { asset: string; generatedAt: string; policy: string; autoStartNewWorker: boolean; originalCommodityWorkPriority: boolean; items: GapItem[] };

const root = process.cwd();
const runtime = resolve(root, "runtime/global-commodity-real-asset-orchestrator");
const paths = {
  lock: resolve(runtime, "orchestrator.lock"),
  checkpoint: resolve(runtime, "checkpoint.json"),
  queue: resolve(runtime, "capability-queue.json"),
  heartbeat: resolve(runtime, "heartbeat.json"),
  manifest: resolve(runtime, "completion-manifest.json")
};
const gapQueuePath = resolve(root, "runtime/commodity/depth-gap-work-queue.json");
const gapCheckpointRoot = resolve(root, "runtime/commodity/depth-gap-checkpoints");
const commodityStatusPath = resolve(root, "runtime-status/commodity.json");
const once = process.argv.includes("--once");
let stopping = false;
let ownsLock = false;
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const readJson = async <T>(file: string, fallback: T) => readFile(file, "utf8").then(value => JSON.parse(value) as T).catch(() => fallback);
async function atomic(file: string, value: unknown) { const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, file); }

async function acquire(asset: string) {
  await mkdir(runtime, { recursive: true });
  try {
    const handle = await open(paths.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    await handle.writeFile(JSON.stringify({ pid: process.pid, asset, role: "READ_ONLY_ORCHESTRATOR", acquiredAt: now() }));
    await handle.close();
    ownsLock = true;
  } catch {
    const owner = await readJson<{ pid?: number }>(paths.lock, {});
    if (owner.pid) { try { process.kill(owner.pid, 0); throw new Error(`ORCHESTRATOR_ALREADY_RUNNING:${owner.pid}`); } catch (error) { if (error instanceof Error && error.message.startsWith("ORCHESTRATOR_ALREADY_RUNNING")) throw error; } }
    await unlink(paths.lock).catch(() => undefined);
    return acquire(asset);
  }
}

function domainState(value: Record<string, unknown> | unknown[]) {
  if (Array.isArray(value)) return value.length ? "CHECKPOINT_REUSED" : "CHECKPOINT_EMPTY";
  if (!Object.keys(value).length) return "CHECKPOINT_MISSING";
  const active = value.processAlive === true || value.alive === true || value.autoContinuing === true || value.auto_continuing === true;
  return active ? "REUSED_EXISTING_PIPELINE" : "CHECKPOINT_RESUME_AVAILABLE";
}

const evidenceByWorker: Record<string, string[]> = {
  ENERGY_PHYSICAL_SUPPLY_DEMAND: ["runtime/energy-physical-supply-demand/coverage-matrix.json", "runtime/energy-physical-supply-demand/status.json"],
  GLOBAL_COMMODITY_INVENTORY: ["runtime/commodity-inventory/coverage-matrix.json", "runtime/commodity-inventory/analytics.json"],
  GLOBAL_ELECTRICITY_MARKETS: ["runtime/electricity-markets/market-coverage-matrix.json", "runtime/electricity-markets/series-coverage-matrix.json"],
  GLOBAL_CARBON_MARKETS: ["runtime/carbon-markets/completion-manifest.json", "runtime/carbon-markets/checkpoint.json"],
  GLOBAL_COMMODITY: ["runtime/commodity/professional-depth/coverage.json", "runtime/commodity/event-engine-state.json"],
  CROSS_ASSET_ANALYTICS_ENGINE: ["runtime/commodity/professional-depth/coverage.json", "runtime/global-futures-depth-orchestrator/completion-manifest.json"],
  MARKET_ATTENTION_ENGINE: ["runtime/commodity/commodity-gap-manifest.json", "runtime/commodity/professional-depth/coverage.json"],
  GLOBAL_COMMODITY_REAL_ASSET_ORCHESTRATOR: ["runtime/global-commodity-real-asset-orchestrator/completion-manifest.json", "runtime/commodity/commodity-gap-manifest.json"],
};

async function publishGapStatus(queue: GapQueue, item: GapItem | null, message: string) {
  const previous = await readJson<any>(commodityStatusPath, null);
  if (!previous) return;
  const completed = queue.items.filter(candidate => candidate.state === "COMPLETE").length;
  const running = queue.items.filter(candidate => candidate.state === "RUNNING").length;
  const pending = queue.items.filter(candidate => candidate.state === "PENDING" || candidate.state === "RETRY_WAIT").length;
  await writeAssetRuntimeStatus({ ...previous, CURRENT_GAP_ID: item?.gap_id ?? null, GAPS_COMPLETED: completed, LAST_GAP_PROGRESS: message, GAP_QUEUE_STATUS: `RUNNING=${running}; PENDING_OR_RETRY=${pending}; COMPLETE=${completed}; BLOCKED=${queue.items.filter(candidate => candidate.state === "BLOCKED").length}`, progressChanged: false });
}

async function consumeOneGap() {
  const queue = await readJson<GapQueue | null>(gapQueuePath, null);
  if (!queue) return { status: "QUEUE_MISSING", currentGap: null };
  const at = Date.now();
  const item = queue.items.find(candidate => candidate.state === "PENDING" || (candidate.state === "RETRY_WAIT" && (!candidate.next_retry_at || Date.parse(candidate.next_retry_at) <= at)));
  if (!item) { await publishGapStatus(queue, null, "Gap queue idle; no eligible deterministic gap"); return { status: "IDLE", currentGap: null }; }
  item.state = "RUNNING";
  item.attempts = Number(item.attempts ?? 0) + 1;
  item.started_at ??= now();
  item.updated_at = now();
  item.completed_at = null;
  item.last_error = null;
  item.checkpoint = `CLAIMED:${item.gap_id}:ATTEMPT_${item.attempts}`;
  await atomic(gapQueuePath, queue);
  await publishGapStatus(queue, item, `${item.gap_id} claimed by ${item.worker}; attempt ${item.attempts}`);
  try {
    const evidenceFiles = evidenceByWorker[item.worker];
    if (!evidenceFiles) throw new Error(`NO_DETERMINISTIC_HANDLER:${item.worker}`);
    const evidence = await Promise.all(evidenceFiles.map(async file => {
      const absolute = resolve(root, file);
      const value = await readJson<Record<string, unknown> | unknown[] | null>(absolute, null);
      if (!value) throw new Error(`REQUIRED_EVIDENCE_MISSING:${file}`);
      return { file, kind: Array.isArray(value) ? "ARRAY" : "OBJECT", records: Array.isArray(value) ? value.length : Object.keys(value).length };
    }));
    const checkpointFile = resolve(gapCheckpointRoot, `${item.gap_id.toLowerCase()}.json`);
    const completedAt = now();
    await mkdir(gapCheckpointRoot, { recursive: true });
    await atomic(checkpointFile, { gap_id: item.gap_id, domain: item.domain, work_type: item.work_type, handler: item.worker, mode: "EXISTING_RUNTIME_CAPABILITY_WIRING", databaseAccess: false, historicalRerun: false, evidence, result: "COMPLETE", completed_at: completedAt });
    item.state = "COMPLETE";
    item.checkpoint = checkpointFile;
    item.updated_at = completedAt;
    item.completed_at = completedAt;
    item.last_error = null;
    await atomic(gapQueuePath, queue);
    await publishGapStatus(queue, item, `${item.gap_id} completed by ${item.worker}; checkpoint ${checkpointFile}`);
    return { status: "COMPLETE", currentGap: item.gap_id, checkpoint: checkpointFile };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    item.last_error = message;
    item.updated_at = now();
    if (message.startsWith("NO_DETERMINISTIC_HANDLER") || message.startsWith("REQUIRED_EVIDENCE_MISSING")) item.state = "BLOCKED";
    else { item.state = "RETRY_WAIT"; item.next_retry_at = new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** item.attempts)).toISOString(); }
    item.checkpoint = `FAILED:${item.gap_id}:ATTEMPT_${item.attempts}`;
    await atomic(gapQueuePath, queue);
    await publishGapStatus(queue, item, `${item.gap_id} ${item.state}: ${message}`);
    return { status: item.state, currentGap: item.gap_id, error: message };
  }
}

async function cycle(config: Config) {
  const previous = await readJson<{ cycle?: number }>(paths.checkpoint, {});
  const domains = await Promise.all(config.domains.map(async domain => {
    const checkpointPath = resolve(root, "runtime", domain.runtime, domain.checkpoint);
    const checkpoint = await readJson<Record<string, unknown> | unknown[]>(checkpointPath, {});
    return { ...domain, state: domainState(checkpoint), checkpointPath, inspectedAt: now() };
  }));
  const capabilities = config.capabilities.map(capability => ({ ...capability, action: capability.status === "CURRENT_AND_AUTO_UPDATING" ? "REUSE_EXISTING_PIPELINE" : "PRESERVE_CLASSIFIED_GAP" }));
  const cycleNumber = Number(previous.cycle ?? 0) + 1;
  const gapConsumer = await consumeOneGap();
  const state = {
    task: config.task,
    asset: config.asset,
    parent: "GLOBAL_COMMODITY_REAL_ASSET_ORCHESTRATOR",
    mode: "INCREMENTAL_METADATA_ONLY",
    cycle: cycleNumber,
    codexRequiredForContinuation: false,
    checkpointResumable: true,
    orchestrationOnly: true,
    databaseAccess: false,
    canonicalWrite: false,
    workerStartOrRestart: false,
    dataCopy: false,
    historyRescan: false,
    oneWriterPerDomain: true,
    futuresBoundary: config.futuresBoundary,
    domains,
    capabilities,
    gapConsumer,
    updatedAt: now()
  };
  await atomic(paths.queue, { policy: "NATIVE_FREQUENCY_EXISTING_WORKER_FIRST", nextPriority: "P0A", items: capabilities, updatedAt: state.updatedAt });
  await atomic(paths.checkpoint, { cycle: cycleNumber, resumable: true, stage: "SCHEDULER_WAIT", nextRunAt: new Date(Date.now() + config.pollIntervalMs).toISOString(), updatedAt: state.updatedAt });
  await atomic(paths.heartbeat, { pid: process.pid, status: once ? "ONCE_COMPLETE" : "AUTO_CONTINUING", canonicalWrite: false, updatedAt: state.updatedAt });
  await atomic(paths.manifest, state);
}

async function main() {
  const config = JSON.parse(await readFile(resolve(root, "config/global-commodity-real-asset-orchestrator.json"), "utf8")) as Config;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  await acquire(config.asset);
  try { do { await cycle(config); if (!once && !stopping) await sleep(config.pollIntervalMs); } while (!once && !stopping); }
  finally { if (ownsLock) await unlink(paths.lock).catch(() => undefined); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
