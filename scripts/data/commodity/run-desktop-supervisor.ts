import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeAssetRuntimeStatus, type AssetRunState } from "../../../lib/data-platform/runtime/writeAssetRuntimeStatus.ts";
import { buildCommodityDepthAudit } from "./build-commodity-depth-audit.ts";

const root = process.cwd();
const runtime = path.join(root, "runtime", "commodity");
const supervisorRuntime = path.join(runtime, "desktop-supervisor");
const healthPath = path.join(supervisorRuntime, "health.json");
const lockPath = path.join(supervisorRuntime, "supervisor.lock");
const checkpointPath = path.join(runtime, "checkpoint.json");
const queuePath = path.join(runtime, "master-queue.json");
const statePath = path.join(runtime, "event-engine-state.json");
const scheduleConfigPath = path.join(root, "config", "commodity-production-events.json");
const professionalCoveragePath = path.join(runtime, "professional-depth", "coverage.json");
const publicStatusPath = path.join(root, "runtime-status", "commodity.json");
const runnerPath = path.join(root, "scripts", "data", "commodity", "run-production-event-engine.ts");
const consumerPath = path.join(root, "scripts", "data", "commodity", "run-commodity-ingestion-consumer.ts");
const depthGapConsumerPath = path.join(root, "scripts", "data", "commodity", "run-depth-gap-consumer.ts");
const faostatPath = path.join(root, "scripts", "data", "commodity", "run-faostat-lifecycle.ts");
const retryWindowMs = 10 * 60 * 1000;
const maxRetriesInWindow = 5;
const heartbeatMs = 15_000;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
async function atomic(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

await mkdir(supervisorRuntime, { recursive: true });
let lock;
try {
  lock = await open(lockPath, "wx");
} catch (error) {
  let existing: { pid?: number } = {};
  try { existing = await readJson(lockPath); } catch {}
  let alive = false;
  if (existing.pid) try { process.kill(existing.pid, 0); alive = true; } catch {}
  if (alive) throw new Error(`COMMODITY_DESKTOP_SUPERVISOR_ALREADY_RUNNING:${existing.pid}`);
  await rm(lockPath, { force: true });
  lock = await open(lockPath, "wx");
}
await lock.writeFile(`${JSON.stringify({ pid: process.pid, owner: "DESKTOP", startedAt: new Date().toISOString() }, null, 2)}\n`);

let child: ChildProcess | undefined;
let consumerChild: ChildProcess | undefined;
let depthGapChild: ChildProcess | undefined;
let faostatChild: ChildProcess | undefined;
let stopping = false;
let retryTimes: number[] = [];

async function queueState() {
  const queue = await readJson(queuePath) as { stages?: Array<{ status?: string }> };
  const counts: Record<string, number> = { COMPLETE: 0, COMPLETE_WITH_GAPS: 0, PENDING: 0, RUNNING: 0 };
  for (const stage of queue.stages ?? []) if (stage.status) counts[stage.status] = (counts[stage.status] ?? 0) + 1;
  return counts;
}

async function writeHealth(status: string, failure?: { component: string; code: number | null; signal: NodeJS.Signals | null }) {
  const [checkpoint, state, counts, scheduleConfig, professionalCoverage] = await Promise.all([readJson(checkpointPath), readJson(statePath), queueState(), readJson(scheduleConfigPath), readJson(professionalCoveragePath)]);
  const activeSources = scheduleConfig.sources.filter((source: { enabled?: boolean }) => source.enabled !== false).length;
  await atomic(healthPath, {
    owner: "DESKTOP",
    desktopPid: child?.pid ?? null,
    consumerPid: consumerChild?.pid ?? null,
    depthGapConsumerPid: depthGapChild?.pid ?? null,
    faostatPid: faostatChild?.pid ?? null,
    supervisorPid: process.pid,
    lastHeartbeat: new Date().toISOString(),
    currentStage: "L18_PRODUCTION_EVENT_ENGINE",
    lastCheckpoint: {
      stage: checkpoint.current_stage,
      status: "PRODUCTION_COMPLETE_WITH_GAPS",
      updatedAt: checkpoint.updated_at,
    },
    queueState: counts,
    eventScheduling: true,
    ingestionConsumer: true,
    latestPath: "runtime/commodity/latest.json",
    incremental: true,
    scheduler: {
      type: "SOURCE_EVENT_ENGINE",
      state: state.status,
      currentSource: state.current ?? null,
      nextRun: state.nextRun ?? null,
      activeSources,
      blockedSources: scheduleConfig.sources.length - activeSources,
    },
    professionalDepth: {
      commodityMasterCoverage: professionalCoverage.commodityMasterCoverage,
      priceSeriesCoverage: professionalCoverage.priceSeriesCoverage,
      taxonomyCoverage: professionalCoverage.taxonomyCoverage,
      officialSpotCoverage: professionalCoverage.officialSpotCoverage,
      officialReferenceCoverage: professionalCoverage.officialReferenceCoverage,
      detailContractPath: "runtime/commodity/professional-depth/detail-contract.json",
    },
    autoContinuing: true,
    status,
    ...(failure ? { lastChildFailure: failure } : {}),
  });
  const processed = Number(counts.COMPLETE ?? 0) + Number(counts.COMPLETE_WITH_GAPS ?? 0);
  const total = processed + Number(counts.PENDING ?? 0) + Number(counts.RUNNING ?? 0);
  const checkpointKey = [checkpoint.current_stage, checkpoint.updated_at, professionalCoverage.generatedAt, state.status, state.current, state.updatedAt].join("|");
  const previousStatus = await readFile(publicStatusPath, "utf8").then(value => JSON.parse(value) as { CHECKPOINT?: string }).catch(() => null);
  const progressChanged = previousStatus?.CHECKPOINT !== checkpointKey;
  if (progressChanged) await buildCommodityDepthAudit().catch(() => undefined);
  const depthManifest = await readFile(path.join(runtime, "commodity-gap-manifest.json"), "utf8").then(value => JSON.parse(value) as { counts?: Record<string, number>; gaps?: Array<{ gap_id: string; status: string }> }).catch(() => null);
  const depthQueue = await readFile(path.join(runtime, "depth-gap-work-queue.json"), "utf8").then(value => JSON.parse(value) as { items?: Array<{ gap_id: string; state: string }> }).catch(() => null);
  const currentGap = depthManifest?.gaps?.find(item => item.status === "QUEUED") ?? null;
  const childrenAlive = child?.exitCode === null && consumerChild?.exitCode === null && depthGapChild?.exitCode === null && faostatChild?.exitCode === null;
  const retryBlocked = status === "UNHEALTHY_RETRY_LIMIT_REACHED";
  const runState: AssetRunState = retryBlocked ? "BLOCKED" : childrenAlive ? "RUNNING" : state.nextRun ? "SCHEDULED_WAIT" : "UNEXPECTED_STOP";
  const priceReady = professionalCoverage.commodityMasterCoverage?.ready === professionalCoverage.commodityMasterCoverage?.total
    && professionalCoverage.priceSeriesCoverage?.ready === professionalCoverage.priceSeriesCoverage?.total;
  const lastProgress = `Commodity completion: ${processed}/${total} layers processed (${counts.COMPLETE ?? 0} complete, ${counts.COMPLETE_WITH_GAPS ?? 0} complete with gaps); identities ${professionalCoverage.commodityMasterCoverage?.ready ?? 0}/${professionalCoverage.commodityMasterCoverage?.total ?? 0}; price series ${professionalCoverage.priceSeriesCoverage?.ready ?? 0}/${professionalCoverage.priceSeriesCoverage?.total ?? 0}; preserved historical rows ${Number(professionalCoverage.originalHistoryRows ?? 0).toLocaleString("en-US")}; checkpoint ${checkpoint.current_stage} completed at ${checkpoint.updated_at}`;
  await writeAssetRuntimeStatus({
    ASSET: "COMMODITY",
    CURRENT_PHASE: "PRODUCTION_CONTINUATION",
    CURRENT_LAYER: "L18_PRODUCTION_EVENT_ENGINE",
    CURRENT_TASK: state.status === "WAITING_SOURCE_EVENT" ? "Scheduler" : "Incremental",
    CURRENT_COMMODITY: null,
    CURRENT_CATEGORY: "Spot / Reference Price",
    CURRENT_MARKET: "GLOBAL",
    CURRENT_SOURCE: state.current ?? null,
    PROCESSED: processed,
    TOTAL: total,
    COVERAGE: total ? `${((processed / total) * 100).toFixed(1)}%; identity ${professionalCoverage.commodityMasterCoverage?.ready ?? 0}/${professionalCoverage.commodityMasterCoverage?.total ?? 0}; price series ${professionalCoverage.priceSeriesCoverage?.ready ?? 0}/${professionalCoverage.priceSeriesCoverage?.total ?? 0}` : null,
    RUN_STATE: runState,
    PROCESS_ID: child?.pid ?? process.pid,
    LAST_PROGRESS_AT: checkpoint.updated_at ?? professionalCoverage.generatedAt ?? null,
    LAST_PROGRESS: lastProgress,
    CHECKPOINT: checkpointKey,
    BLOCKER: retryBlocked ? `${failure?.component ?? "COMMODITY_WORKER"}_RETRY_LIMIT_REACHED` : null,
    NEXT: state.status === "WAITING_SOURCE_EVENT" ? `Run next native publication event for ${state.current ?? "configured source"}` : "Continue existing checkpointed commodity work",
    NEXT_RUN_AT: state.nextRun ?? null,
    PRICE_STATUS: priceReady ? "REFERENCE_CORE_STABLE" : "BUILDING",
    FUNDAMENTAL_STATUS: "CONTINUING_EXISTING_DOMAIN_PIPELINES",
    DEPTH_AUDIT_STATUS: depthManifest ? "COMPLETE_CONTINUING" : "NOT_READY",
    DEPTH_GAPS_TOTAL: depthManifest?.counts?.total ?? null,
    DEPTH_GAPS_P0: depthManifest?.counts?.P0 ?? null,
    DEPTH_GAPS_P1: depthManifest?.counts?.P1 ?? null,
    DEPTH_GAPS_P2: depthManifest?.counts?.P2 ?? null,
    DEPTH_GAPS_P3: depthManifest?.counts?.P3 ?? null,
    CURRENT_GAP_ID: currentGap?.gap_id ?? null,
    GAPS_COMPLETED: depthManifest?.gaps?.filter(item => item.status === "COMPLETE").length ?? 0,
    LAST_GAP_PROGRESS: currentGap ? `${currentGap.gap_id} queued for existing deterministic worker lifecycle` : "No deterministic gap currently queued",
    GAP_QUEUE_STATUS: depthQueue?.items?.some(item => item.state === "RUNNING") ? "RUNNING" : depthQueue?.items?.some(item => item.state === "RETRY_WAIT") ? "RETRY_WAIT" : depthQueue?.items?.some(item => item.state === "PENDING") ? "PENDING" : "COMPLETE",
    QUOTE_STATUS: "NOT_READY",
    CONTINUING: retryBlocked ? "NO" : "YES",
    progressChanged,
  }).catch(() => undefined);
}

const stop = () => {
  stopping = true;
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (consumerChild && consumerChild.exitCode === null) consumerChild.kill("SIGTERM");
  if (depthGapChild && depthGapChild.exitCode === null) depthGapChild.kill("SIGTERM");
  if (faostatChild && faostatChild.exitCode === null) faostatChild.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  while (!stopping) {
    child = spawn(process.execPath, ["--experimental-strip-types", runnerPath], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    consumerChild = spawn(process.execPath, ["--env-file=.env", "--experimental-strip-types", consumerPath], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    depthGapChild = spawn(process.execPath, ["--env-file=.env", "--experimental-strip-types", depthGapConsumerPath], {
      cwd: root,
      env: { ...process.env, MAX_DB_CONCURRENCY: "1" },
      stdio: "inherit",
      windowsHide: true,
    });
    faostatChild = spawn(process.execPath, ["--experimental-strip-types", faostatPath], {
      cwd: root,
      env: { ...process.env, MAX_DB_CONCURRENCY: "1" },
      stdio: "inherit",
      windowsHide: true,
    });
    await writeHealth("HEALTHY_WAITING");

    let failure: { component: string; code: number | null; signal: NodeJS.Signals | null } | undefined;
    while (!stopping && child.exitCode === null && consumerChild.exitCode === null && depthGapChild.exitCode === null && faostatChild.exitCode === null) {
      await sleep(heartbeatMs);
      if (child.exitCode === null && consumerChild.exitCode === null && depthGapChild.exitCode === null && faostatChild.exitCode === null) await writeHealth("HEALTHY_WAITING");
    }
    if (stopping) break;
    failure = child.exitCode !== null
      ? { component: "EVENT_ENGINE", code: child.exitCode, signal: child.signalCode }
      : consumerChild.exitCode !== null
        ? { component: "INGESTION_CONSUMER", code: consumerChild.exitCode, signal: consumerChild.signalCode }
        : depthGapChild.exitCode !== null
          ? { component: "DEPTH_GAP_CONSUMER", code: depthGapChild.exitCode, signal: depthGapChild.signalCode }
          : { component: "FAOSTAT", code: faostatChild.exitCode, signal: faostatChild.signalCode };
    if (child.exitCode === null) child.kill("SIGTERM");
    if (consumerChild.exitCode === null) consumerChild.kill("SIGTERM");
    if (depthGapChild.exitCode === null) depthGapChild.kill("SIGTERM");
    if (faostatChild.exitCode === null) faostatChild.kill("SIGTERM");
    const now = Date.now();
    retryTimes = retryTimes.filter((time) => now - time < retryWindowMs);
    if (retryTimes.length >= maxRetriesInWindow) {
      await writeHealth("UNHEALTHY_RETRY_LIMIT_REACHED", failure);
      process.exitCode = 1;
      break;
    }
    retryTimes.push(now);
    await writeHealth("RECOVERING_CHILD_FAILURE", failure);
    await sleep(Math.min(60_000, 2 ** retryTimes.length * 1_000));
  }
} finally {
  await lock.close();
  await rm(lockPath, { force: true });
}
