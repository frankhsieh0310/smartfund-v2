import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeAssetRuntimeStatus } from "../../../lib/data-platform/runtime/writeAssetRuntimeStatus.ts";

type TerminalStatus = "CURRENT_AND_AUTO_UPDATING" | "MAX_SOURCE_DEPTH_REACHED" | "SOURCE_CONSTRAINED" | "ACCESS_CONSTRAINED" | "LICENSE_CONSTRAINED" | "TIME_DEPTH_CONSTRAINED" | "INPUT_CONSTRAINED" | "MAPPING_CONSTRAINED" | "CONFIGURATION_CONSTRAINED" | "SCHEMA_BLOCKED" | "NOT_APPLICABLE";
type Domain = { id: string; runtime: string; priority: "P0A" | "P0B" | "P1"; status: TerminalStatus };
type Capability = { id: string; priority: "P0A" | "P0B" | "P1"; status: TerminalStatus };
type Config = { version: number; asset: string; pollIntervalMs: number; databaseBackoffMs: number[]; boundedBatchSize: number; sharedMarketDataInfrastructure: object; counts: object; domains: Domain[]; capabilities: Capability[] };

const root = process.cwd();
const runtime = resolve(root, "runtime/global-futures-depth-orchestrator");
const paths = { lock: resolve(runtime, "single-writer.lock"), checkpoint: resolve(runtime, "checkpoint.json"), queue: resolve(runtime, "work-queue.json"), heartbeat: resolve(runtime, "heartbeat.json"), manifest: resolve(runtime, "completion-manifest.json") };
const once = process.argv.includes("--once");
const statusOnly = process.argv.includes("--status-only");
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
  for (const candidate of ["runner.pid", "backfill-runner.pid", "commodity-futures.pid", "launcher.pid", "pid", "checkpoint.json", "health.json"]) {
    const file = resolve(dir, candidate);
    const raw = await readFile(file, "utf8").catch(() => "");
    let pid = Number(raw.trim());
    if (!pid) try { const value = JSON.parse(raw); pid = Number(value.pid ?? value.ownership?.canonicalOwnerPid); } catch { pid = 0; }
    if (alive(pid)) return { pid, file };
  }
  return null;
}

async function databaseSaturated() {
  const analytics = await readJson<{ error?: string }>(resolve(root, "runtime/futures-positioning/analytics-checkpoint.json"), {});
  return /max clients|EMAXCONNSESSION/i.test(analytics.error ?? "");
}

type DomainCheckpoint = Record<string, unknown> & { pid?: number; updatedAt?: string; nextRunAt?: string; nextCycleAt?: string; stage?: string; currentStage?: string; scope?: string; currentScope?: string; status?: string };
async function futuresRuntimeStatus(domains: Array<Domain & { pid: number | null }>) {
  const sources = [
    { domain: "EQUITY_INDEX", market: "GLOBAL_EQUITY_INDEX_FUTURES", exchange: "MULTI_VENUE", family: "30_CONFIGURED_ROOTS", source: "OFFICIAL_EXCHANGE_ADAPTERS + YAHOO_CHART_SUPPLEMENTAL", file: "runtime/equity-index-futures/checkpoint/runner.json" },
    { domain: "COMMODITY", market: "GLOBAL_COMMODITY_FUTURES", exchange: "COMEX/NYMEX/CBOT/CME_GROUP", family: "GC/HG/CL/ZC/LE", source: "CME_GROUP", file: "runtime/commodity-futures/checkpoint.json" },
    { domain: "INTEREST_RATE", market: "GLOBAL_INTEREST_RATE_FUTURES", exchange: "OSE", family: "TONA_3M", source: "JPX_OSE_OFFICIAL_SETTLEMENT_CSV", file: "runtime/interest-futures/checkpoint.json" },
    { domain: "POSITIONING", market: "CFTC", exchange: "CFTC_REPORTING_MARKETS", family: "LEGACY/DISAGGREGATED/TFF", source: "CFTC_OFFICIAL", file: "runtime/futures-positioning/checkpoint.json" }
  ];
  const checkpoints = await Promise.all(sources.map(async source => ({ ...source, checkpoint: await readJson<DomainCheckpoint>(resolve(root, source.file), {}) })));
  checkpoints.sort((a, b) => Date.parse(b.checkpoint.updatedAt ?? "") - Date.parse(a.checkpoint.updatedAt ?? ""));
  const current = checkpoints[0];
  const commodityManifest = await readJson<any>(resolve(root, "runtime/commodity-futures/completion-manifest.json"), {});
  const positioning = await readJson<any>(resolve(root, "runtime/futures-positioning/checkpoint.json"), {});
  const result = commodityManifest.result ?? {};
  const metrics = result.metrics ?? {};
  const completedAt = commodityManifest.completedAt ?? null;
  const previous = await readJson<any>(resolve(root, "runtime-status/futures.json"), {});
  const depth = await readJson<any>(resolve(root, "runtime/futures/futures-gap-manifest.json"), {});
  const currentGap = depth.gaps?.find((item: any) => item.status === "DELEGATED_EXISTING_WORKER") ?? null;
  const progressKey = JSON.stringify([completedAt, result.latest, metrics.newContracts, metrics.newObservations, metrics.updatedObservations, metrics.noOpCurrent]);
  const progressChanged = previous.CHECKPOINT !== progressKey;
  const currentDomain = domains.find(domain => domain.id === current.domain);
  const currentPid = currentDomain?.pid ?? (Number(current.checkpoint.pid) || null);
  const stage = String(current.checkpoint.currentStage ?? current.checkpoint.stage ?? "Scheduler");
  const scheduled = /SCHEDULE|WAIT|IDLE/i.test(`${stage}:${current.checkpoint.status ?? ""}`);
  const blocker = current.domain === "POSITIONING" && /FAILED/.test(String(current.checkpoint.status)) ? String((current.checkpoint as any).error ?? "POSITIONING_CHECKPOINT_FAILED") : null;
  const productRoots = Array.isArray(result.products) ? result.products.map((item: any) => item.root).join("/") : "GC/HG/CL/ZC/LE";
  const lastProgress = `Commodity incremental cycle completed; ${productRoots}; latest=${result.latest ?? "UNKNOWN"}; +${metrics.newContracts ?? 0} contracts; +${metrics.newObservations ?? 0} observations; ${metrics.updatedObservations ?? 0} updated; ${metrics.noOpCurrent ?? 0} no-op`;
  await writeAssetRuntimeStatus({
    ASSET: "FUTURES", CURRENT_PHASE: "CONTINUOUS_DEPTH_AND_INCREMENTAL", CURRENT_LAYER: current.domain,
    CURRENT_TASK: /HISTORICAL/.test(stage) ? "Historical OHLCV" : /POSITION|CFTC/.test(current.domain) ? "CFTC COT" : /SCHEDULE/.test(stage) ? "Scheduler" : "Incremental",
    CURRENT_MARKET: current.market, CURRENT_EXCHANGE: current.exchange, CURRENT_CONTRACT_FAMILY: current.family, CURRENT_INDEX_FAMILY: null,
    CURRENT_SOURCE: current.source, SOURCE: current.source, PROCESSED: Number(metrics.noOpCurrent ?? 0), TOTAL: null,
    COVERAGE: `Commodity canary families ${productRoots}; latest ${result.latest ?? "UNKNOWN"}`, RUN_STATE: currentPid ? "RUNNING" : scheduled && (current.checkpoint.nextRunAt || current.checkpoint.nextCycleAt) ? "SCHEDULED_WAIT" : blocker ? "BLOCKED" : "UNEXPECTED_STOP",
    PROCESS_ID: currentPid, HEARTBEAT_AT: new Date().toISOString(), LAST_PROGRESS_AT: completedAt, LAST_PROGRESS: lastProgress,
    CHECKPOINT: progressKey, BLOCKER: blocker, NEXT: scheduled ? "Incremental" : stage, NEXT_RUN_AT: String(current.checkpoint.nextRunAt ?? current.checkpoint.nextCycleAt ?? "") || null,
    DEPTH_AUDIT_STATUS: depth.counts ? "COMPLETE_CONTINUING" : "NOT_READY", DEPTH_GAPS_TOTAL: depth.counts?.total ?? null,
    DEPTH_GAPS_P0: depth.counts?.P0 ?? null, DEPTH_GAPS_P1: depth.counts?.P1 ?? null, DEPTH_GAPS_P2: depth.counts?.P2 ?? null, DEPTH_GAPS_P3: depth.counts?.P3 ?? null,
    DETERMINISTIC_GAPS_TOTAL: depth.counts?.deterministic ?? null, BLOCKED_GAPS_TOTAL: depth.counts?.blocked ?? null,
    CURRENT_GAP_ID: currentGap?.gap_id ?? null, CURRENT_GAP_DOMAIN: currentGap ? `${currentGap.domain}/${currentGap.subdomain}` : null,
    CURRENT_EXCHANGE_GAP: currentGap?.exchange ?? null, CURRENT_CONTRACT_FAMILY_GAP: currentGap?.contract_family ?? null,
    GAPS_COMPLETED: depth.gaps?.filter((item: any) => item.status === "COMPLETE").length ?? 0,
    LAST_GAP_PROGRESS: currentGap ? `${currentGap.gap_id} delegated to ${currentGap.target_worker}` : "No deterministic gap queued",
    GAP_QUEUE_STATUS: currentGap ? "ACTIVE_DELEGATED" : "EMPTY", QUOTE_STATUS: "NOT_READY", CONTINUING: blocker ? "NO" : "YES", progressChanged
  });
}

async function cycle(config: Config) {
  const previous = await readJson<{ cycle?: number }>(paths.checkpoint, {});
  const domains = await Promise.all(config.domains.map(async domain => {
    const owner = await runtimeOwner(domain.runtime);
    return { ...domain, action: owner ? "REUSED_ACTIVE_WRITER" : "CHECKPOINT_RESUME_PENDING", pid: owner?.pid ?? null, checkedAt: iso() };
  }));
  const activeDomainWriters = domains.filter(domain => domain.pid).map(domain => ({ domain: domain.id, runtime: domain.runtime, pid: domain.pid }));
  const saturated = await databaseSaturated();
  const state = { task: "GLOBAL_FUTURES_CONTINUOUS_DEPTH_AND_INTRADAY_ORCHESTRATION_V2", asset: config.asset, mode: "INCREMENTAL_ONLY", autoContinuing: true, codexRequiredForContinuation: false, checkpointResumable: true, boundedBatching: true, boundedBatchSize: config.boundedBatchSize, databaseBackoff: "ENABLED", databaseState: saturated ? "BACKOFF" : "AVAILABLE", maxSourceDepthPolicy: "ACTIVE", doubleWriter: false, unknown: 0, canonicalWrite: false, counts: config.counts, sharedMarketDataInfrastructure: config.sharedMarketDataInfrastructure, activeDomainWriters, domains, capabilities: config.capabilities, cycle: Number(previous.cycle ?? 0) + 1, updatedAt: iso() };
  const depthQueue = await readJson<any>(resolve(root, "runtime/futures/depth-gap-work-queue.json"), { items: [] });
  await atomic(paths.queue, { ...state, queuePolicy: "CHANGED_ROOTS_OR_CONTRACTS_ONLY", action: saturated ? "DATABASE_BACKOFF" : "BACKGROUND_CONTINUE", depthGapQueue: depthQueue.items ?? [] });
  await atomic(paths.checkpoint, { cycle: state.cycle, resumable: true, nextPriority: "P0A", databaseState: state.databaseState, updatedAt: state.updatedAt });
  await atomic(paths.heartbeat, { pid: process.pid, status: saturated ? "DATABASE_BACKOFF" : "AUTO_CONTINUING", stage: "SCHEDULER_WAIT", canonicalWrite: false, updatedAt: iso() });
  await atomic(paths.manifest, state);
  await futuresRuntimeStatus(domains);
  failures = 0;
}

async function main() {
  const config = JSON.parse(await readFile(resolve(root, "config/global-futures-depth-orchestrator.json"), "utf8")) as Config;
  if (statusOnly) {
    const domains = await Promise.all(config.domains.map(async domain => ({ ...domain, pid: (await runtimeOwner(domain.runtime))?.pid ?? null })));
    await futuresRuntimeStatus(domains);
    return;
  }
  process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; });
  await acquire(config.asset);
  try { do { try { await cycle(config); } catch (error) { failures += 1; const waitMs = config.databaseBackoffMs[Math.min(failures - 1, config.databaseBackoffMs.length - 1)]; await atomic(paths.heartbeat, { pid: process.pid, status: "DATABASE_BACKOFF", waitMs, error: String(error), updatedAt: iso() }); if (once) throw error; await sleep(waitMs); continue; } if (!once && !stopping) await sleep(config.pollIntervalMs); } while (!once && !stopping); }
  finally { if (ownsLock) await unlink(paths.lock).catch(() => undefined); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
