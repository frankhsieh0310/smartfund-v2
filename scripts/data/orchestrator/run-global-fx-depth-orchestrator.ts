import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeAssetRuntimeStatus } from "../../../lib/data-platform/runtime/writeAssetRuntimeStatus.ts";

type TerminalStatus = "CURRENT_AND_AUTO_UPDATING" | "MAX_SOURCE_DEPTH_REACHED" | "REALTIME" | "NEAR_REALTIME" | "DELAYED" | "EOD_ONLY" | "SOURCE_CONSTRAINED" | "ACCESS_CONSTRAINED" | "LICENSE_CONSTRAINED" | "TIME_DEPTH_CONSTRAINED" | "INPUT_CONSTRAINED" | "MAPPING_CONSTRAINED" | "CONFIGURATION_CONSTRAINED" | "DERIVATION_NOT_READY" | "NOT_APPLICABLE";
type Item = { id: string; priority: "P0A" | "P0B" | "P1"; status: TerminalStatus };
type Domain = Item & { runtime: string };
type Config = { version: number; asset: string; pollIntervalMs: number; databaseBackoffMs: number[]; boundedBatchSize: number; gapConsumerBatchSize: number; maxDbConcurrency: number; dbPoolMode: string; counts: object; sharedMarketDataInfrastructure: object; domains: Domain[]; capabilities: Item[] };
type GapState = "QUEUED" | "RUNNING" | "COMPLETE" | "WAITING_DEPENDENCY" | "BLOCKED" | "RETRY_WAIT";
type Gap = Record<string, any> & { gap_id: string; domain: string; target_worker: string; queue_status: GapState; attempts?: number; checkpoint?: string; started_at?: string | null; updated_at?: string | null; completed_at?: string | null; last_error?: string | null; next_retry_at?: string | null };
type GapQueue = Record<string, any> & { status: string; items: Gap[] };

const root = process.cwd();
const runtime = resolve(root, "runtime/global-fx-depth-orchestrator");
const paths = { lock: resolve(runtime, "single-writer.lock"), checkpoint: resolve(runtime, "checkpoint.json"), queue: resolve(runtime, "work-queue.json"), heartbeat: resolve(runtime, "heartbeat.json"), manifest: resolve(runtime, "completion-manifest.json") };
const gapQueuePath = resolve(root, "runtime/fx/depth-gap-work-queue.json");
const once = process.argv.includes("--once");
let ownsLock = false;
let stopping = false;
let failures = 0;
const iso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const readJson = async <T>(file: string, fallback: T) => readFile(file, "utf8").then(text => JSON.parse(text) as T).catch(() => fallback);
async function atomic(file: string, value: unknown) { const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, file); }

async function acquire(asset: string) {
  await mkdir(runtime, { recursive: true });
  try { const handle = await open(paths.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY); await handle.writeFile(JSON.stringify({ pid: process.pid, asset, role: "READ_ONLY_ORCHESTRATOR", acquiredAt: iso() })); await handle.close(); ownsLock = true; }
  catch { const owner = await readJson<{ pid?: number }>(paths.lock, {}); if (alive(owner.pid)) throw new Error(`DOUBLE_ORCHESTRATOR:${owner.pid}`); await unlink(paths.lock).catch(() => undefined); return acquire(asset); }
}

async function runtimeOwner(name: string) {
  const dir = resolve(root, "runtime", name);
  for (const candidate of ["launcher.pid", "runner.pid", "pid", "health.json", "checkpoint.json"]) {
    const file = resolve(dir, candidate);
    const raw = await readFile(file, "utf8").catch(() => "");
    let pid = Number(raw.trim());
    if (!pid) try { const value = JSON.parse(raw); pid = Number(value.pid ?? value.ownerPid); } catch { pid = 0; }
    if (alive(pid)) return { pid, file };
  }
  return null;
}

const terminalSourceBlock = (gap: Gap) => gap.current_status === "BLOCKED_LICENSE" || gap.current_status === "BLOCKED_AUTH" || gap.current_status === "BLOCKED_SCHEMA" || gap.blocker === "LICENSE_CONSTRAINED";
const dependencyGroup = (domain: string) => {
  if (["Spot","Reference Rate","Mid","Historical","Latest","Intraday","Daily"].includes(domain)) return 0;
  if (["Cross Rates","Triangulation"].includes(domain)) return 1;
  if (["Forward Curve","Carry","Carry History","Interest Rate Differential","Rate Differential History"].includes(domain)) return 2;
  if (["REER","REER History","Central Bank Reserves","Reserve History","Positioning"].includes(domain)) return 3;
  if (["Relative Strength","Return","Volatility","Drawdown","Rolling Correlation","Technical / Quant"].includes(domain)) return 4;
  if (["Seasonality","Historical Percentile"].includes(domain)) return 5;
  if (["Event Intelligence","Central Bank Events","CPI / GDP / Employment linkage","Cross-Asset Relationships"].includes(domain)) return 6;
  return 7;
};
const prerequisitesReady = (gap: Gap, items: Gap[]) => {
  const group = dependencyGroup(gap.domain);
  if (group === 0) return true;
  const lower = items.filter(item => dependencyGroup(item.domain) < group && !terminalSourceBlock(item));
  return lower.every(item => item.queue_status === "COMPLETE" || item.queue_status === "BLOCKED");
};

async function consumeGapQueue(config: Config, domains: Array<Domain & { pid: number | null }>, fxCheckpoint: any) {
  const queue = await readJson<GapQueue | null>(gapQueuePath, null);
  if (!queue) return null;
  const now = iso();
  const workerPids: Record<string, number | null> = {
    STANDALONE_FX: domains.find(item => item.id === "SPOT_HISTORY_INTRADAY")?.pid ?? null,
    FX_FORWARD_POINTS: domains.find(item => item.id === "FORWARD_POINTS")?.pid ?? null,
    GLOBAL_FX_RESERVES: domains.find(item => item.id === "FX_RESERVES")?.pid ?? null,
    GLOBAL_FX_ORCHESTRATOR: process.pid,
  };
  for (const item of queue.items) {
    item.attempts ??= 0; item.started_at ??= null; item.updated_at ??= queue.generatedAt ?? now; item.completed_at ??= null; item.last_error ??= null; item.next_retry_at ??= null;
    if (item.queue_status === "RUNNING" && item.target_worker !== "GLOBAL_FX_ORCHESTRATOR") {
      const pid = workerPids[item.target_worker];
      if (pid) { item.checkpoint = `${item.target_worker}:${item.target_worker === "STANDALONE_FX" ? fxCheckpoint.current ?? "CHECKPOINT_PENDING" : "RUNTIME_CHECKPOINT_ACTIVE"}`; item.updated_at = now; }
      else { item.queue_status = "RETRY_WAIT"; item.last_error = "TARGET_WORKER_NOT_RUNNING"; item.next_retry_at = new Date(Date.now() + 60_000).toISOString(); item.updated_at = now; }
    }
    if (item.queue_status === "RETRY_WAIT" && item.next_retry_at && Date.parse(item.next_retry_at) <= Date.now() && item.attempts < 3) item.queue_status = "QUEUED";
    if (item.queue_status === "RETRY_WAIT" && item.attempts >= 3) { item.queue_status = "BLOCKED"; item.last_error = item.last_error ?? "BOUNDED_RETRY_EXHAUSTED"; item.updated_at = now; }
  }
  const candidate = queue.items.find(item => item.queue_status === "QUEUED" || item.queue_status === "WAITING_DEPENDENCY");
  if (candidate) {
    if (terminalSourceBlock(candidate)) { candidate.queue_status = "BLOCKED"; candidate.attempts = Number(candidate.attempts ?? 0) + 1; candidate.started_at ??= now; candidate.updated_at = now; candidate.completed_at = now; candidate.checkpoint = `BLOCKED:${candidate.blocker ?? candidate.current_status}`; candidate.last_error = candidate.blocker ?? candidate.current_status; }
    else if (!prerequisitesReady(candidate, queue.items)) { candidate.queue_status = "WAITING_DEPENDENCY"; candidate.updated_at = now; candidate.checkpoint = `WAITING_DEPENDENCY:GROUP_${dependencyGroup(candidate.domain)}`; candidate.last_error = null; }
    else {
      candidate.queue_status = "RUNNING"; candidate.attempts = Number(candidate.attempts ?? 0) + 1; candidate.started_at ??= now; candidate.updated_at = now; candidate.last_error = null; candidate.next_retry_at = null;
      if (candidate.target_worker === "GLOBAL_FX_ORCHESTRATOR") {
        const projection = resolve(runtime, "gap-capabilities", `${candidate.gap_id}.json`); await mkdir(resolve(runtime, "gap-capabilities"), { recursive: true });
        await atomic(projection, { gapId: candidate.gap_id, domain: candidate.domain, source: candidate.source, methodology: candidate.work_type, canonicalWrite: false, dependencyGroup: dependencyGroup(candidate.domain), completedAt: now });
        candidate.checkpoint = `CAPABILITY_PROJECTION:${candidate.gap_id}`; candidate.queue_status = "COMPLETE"; candidate.completed_at = now;
      } else {
        const pid = workerPids[candidate.target_worker];
        if (pid) candidate.checkpoint = `${candidate.target_worker}:${candidate.target_worker === "STANDALONE_FX" ? fxCheckpoint.current ?? "CHECKPOINT_PENDING" : "RUNTIME_CHECKPOINT_ACTIVE"}`;
        else { candidate.queue_status = "RETRY_WAIT"; candidate.last_error = "TARGET_WORKER_NOT_RUNNING"; candidate.next_retry_at = new Date(Date.now() + 1_000).toISOString(); }
      }
    }
  }
  const counts = { completed: queue.items.filter(item=>item.queue_status==="COMPLETE").length, waiting: queue.items.filter(item=>item.queue_status==="WAITING_DEPENDENCY").length, blocked: queue.items.filter(item=>item.queue_status==="BLOCKED").length, running: queue.items.filter(item=>item.queue_status==="RUNNING").length };
  queue.status = counts.running ? "RUNNING" : queue.items.some(item=>["QUEUED","RETRY_WAIT"].includes(item.queue_status)) ? "ACTIVE" : counts.waiting ? "WAITING_DEPENDENCY" : "COMPLETE";
  queue.consumer = { worker:"GLOBAL_FX_ORCHESTRATOR", processId:process.pid, originalFxWorkPriority:true, boundedBatchSize:config.gapConsumerBatchSize, dbPoolMode:config.dbPoolMode, maxDbConcurrency:config.maxDbConcurrency, actualDbConcurrency:0, prismaClients:0, retryLimit:3, backoffMs:[1000,2000], updatedAt:now };
  await atomic(gapQueuePath, queue);
  return { queue, counts, current: queue.items.find(item=>item.queue_status==="RUNNING") ?? queue.items.find(item=>item.queue_status==="WAITING_DEPENDENCY") ?? null };
}

async function cycle(config: Config) {
  const previous = await readJson<{ cycle?: number }>(paths.checkpoint, {});
  const domains = await Promise.all(config.domains.map(async domain => {
    const owner = await runtimeOwner(domain.runtime);
    return { ...domain, action: owner ? "REUSED_ACTIVE_WRITER" : "CHECKPOINT_RESUME_PENDING", pid: owner?.pid ?? null, checkedAt: iso() };
  }));
  const activeDomainWriters = domains.filter(domain => domain.pid).map(domain => ({ domain: domain.id, runtime: domain.runtime, pid: domain.pid }));
  const fxCheckpoint = await readJson<{ stage?: string; current?: string; completed?: Record<string, string>; updatedAt?: string }>(resolve(root, "runtime/fx/checkpoint.json"), {});
  const fxHeartbeat = await readJson<{ heartbeatAt?: string }>(resolve(root, "runtime/fx/heartbeat.json"), {});
  const current = fxCheckpoint.current ?? null;
  const parts = current?.split(":") ?? [];
  const currentPair = parts.length >= 3 ? parts[1] : null;
  const currentInterval = parts.length >= 3 ? parts[2] : null;
  const currentPid = activeDomainWriters.find(writer => writer.domain === "SPOT_HISTORY_INTRADAY")?.pid ?? null;
  const previousPublic = await readJson<{ CHECKPOINT?: string; LAST_PROGRESS?: string }>(resolve(root, "runtime-status/fx.json"), {});
  const processed = Object.keys(fxCheckpoint.completed ?? {}).length;
  const progressChanged = previousPublic.CHECKPOINT !== current || !previousPublic.LAST_PROGRESS;
  const lastProgress = currentPair && currentInterval ? `FX ${fxCheckpoint.stage ?? "INCREMENTAL"}: checkpoint advanced to ${currentPair} ${currentInterval}; ${processed}/${528 * 12} processed in current cycle` : undefined;
  const gapManifest = await readJson<any>(resolve(root, "runtime/fx/fx-gap-manifest.json"), null);
  const consumed = await consumeGapQueue(config, domains, fxCheckpoint);
  const gapQueue = consumed?.queue ?? null;
  const currentGap = consumed?.current ?? null;
  const state = { task: "GLOBAL_FX_CONTINUOUS_PROFESSIONAL_DEPTH_AND_INTRADAY_ORCHESTRATION_V2", asset: config.asset, mode: "INCREMENTAL_ONLY", autoContinuing: true, codexRequiredForContinuation: false, checkpointResumable: true, boundedBatching: true, boundedBatchSize: config.boundedBatchSize, databaseBackoff: "ENABLED", maxSourceDepthPolicy: "ACTIVE", doubleWriter: false, unknown: 0, canonicalWrite: false, counts: config.counts, sharedMarketDataInfrastructure: config.sharedMarketDataInfrastructure, activeDomainWriters, domains, capabilities: config.capabilities, cycle: Number(previous.cycle ?? 0) + 1, updatedAt: iso() };
  await atomic(paths.queue, { ...state, queuePolicy: "CHANGED_PAIR_TIMEFRAME_OR_DOMAIN_ONLY", analyticsPolicy: "AFFECTED_PAIR_TIMEFRAME_WINDOW_ONLY", action: "BACKGROUND_CONTINUE" });
  await atomic(paths.checkpoint, { cycle: state.cycle, resumable: true, nextPriority: "P0A", updatedAt: state.updatedAt });
  await atomic(paths.heartbeat, { pid: process.pid, status: "AUTO_CONTINUING", stage: "SCHEDULER_WAIT", canonicalWrite: false, updatedAt: iso() });
  await atomic(paths.manifest, state);
  await writeAssetRuntimeStatus({ ASSET: "FX", CURRENT_PHASE: fxCheckpoint.stage ?? "INCREMENTAL", CURRENT_LAYER: currentInterval === "1d" ? "Daily" : "Intraday", CURRENT_TASK: fxCheckpoint.stage === "HISTORICAL" ? "Historical" : "Incremental", CURRENT_MARKET: "GLOBAL", CURRENT_PAIR: currentPair, CURRENT_BASE_CURRENCY: currentPair?.slice(0, 3) ?? null, CURRENT_QUOTE_CURRENCY: currentPair?.slice(3, 6) ?? null, CURRENT_SOURCE: "YAHOO_CHART", PROCESSED: processed, TOTAL: 528 * 12, COVERAGE: `${((processed / (528 * 12)) * 100).toFixed(1)}%`, RUN_STATE: currentPid ? "RUNNING" : "UNEXPECTED_STOP", PROCESS_ID: currentPid, HEARTBEAT_AT: fxHeartbeat.heartbeatAt, CHECKPOINT: current, BLOCKER: null, NEXT: "Continue next checkpointed FX pair/interval", NEXT_RUN_AT: null, QUOTE_STATUS: "NOT_READY", CONTINUING: "YES", LAST_PROGRESS: lastProgress, progressChanged, DEPTH_AUDIT_STATUS: gapManifest ? "COMPLETE_GAPS_QUEUED" : null, DEPTH_GAPS_TOTAL: gapManifest?.counts?.total ?? 0, DEPTH_GAPS_P0: gapManifest?.counts?.P0 ?? 0, DEPTH_GAPS_P1: gapManifest?.counts?.P1 ?? 0, DEPTH_GAPS_P2: gapManifest?.counts?.P2 ?? 0, DEPTH_GAPS_P3: gapManifest?.counts?.P3 ?? 0, DETERMINISTIC_GAPS_TOTAL: gapManifest?.counts?.deterministic ?? 0, BLOCKED_GAPS_TOTAL: gapManifest?.counts?.blocked ?? 0, CURRENT_GAP_ID: currentGap?.gap_id ?? null, CURRENT_GAP_DOMAIN: currentGap?.domain ?? null, CURRENT_GAP_STATE: currentGap?.queue_status ?? null, GAPS_COMPLETED: consumed?.counts.completed ?? 0, LAST_GAP_PROGRESS: currentGap ? `${currentGap.gap_id} ${currentGap.queue_status}: ${currentGap.checkpoint}` : "Gap queue has no active item", GAP_QUEUE_STATUS: gapQueue?.status ?? null, WAITING_DEPENDENCIES: consumed?.counts.waiting ?? 0, BLOCKED_GAPS: consumed?.counts.blocked ?? 0, DB_POOL_STATUS: `${config.dbPoolMode}; MAX_CONCURRENCY=${config.maxDbConcurrency}; CONSUMER_DB_CONNECTIONS=0` });
  failures = 0;
}

async function main() {
  const config = JSON.parse(await readFile(resolve(root, "config/global-fx-depth-orchestrator.json"), "utf8")) as Config;
  process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; });
  await acquire(config.asset);
  try { do { try { await cycle(config); } catch (error) { failures += 1; const waitMs = config.databaseBackoffMs[Math.min(failures - 1, config.databaseBackoffMs.length - 1)]; await atomic(paths.heartbeat, { pid: process.pid, status: "DATABASE_BACKOFF", waitMs, error: String(error), updatedAt: iso() }); if (once) throw error; await sleep(waitMs); continue; } if (!once && !stopping) await sleep(config.pollIntervalMs); } while (!once && !stopping); }
  finally { if (ownsLock) await unlink(paths.lock).catch(() => undefined); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
