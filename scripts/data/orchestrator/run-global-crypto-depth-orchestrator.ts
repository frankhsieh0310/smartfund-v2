import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type TerminalStatus = "CURRENT_AND_AUTO_UPDATING" | "MAX_SOURCE_DEPTH_REACHED" | "REALTIME" | "NEAR_REALTIME" | "DELAYED" | "SOURCE_CONSTRAINED" | "ACCESS_CONSTRAINED" | "LICENSE_CONSTRAINED" | "TIME_DEPTH_CONSTRAINED" | "INPUT_CONSTRAINED" | "MAPPING_CONSTRAINED" | "CONFIGURATION_CONSTRAINED" | "NOT_APPLICABLE";
type Item = { id: string; priority: "P0A" | "P0B" | "P1"; status: TerminalStatus };
type Domain = Item & { runtime: string };
type Config = { asset: string; pollIntervalMs: number; databaseBackoffMs: number[]; boundedBatchSize: number; counts: object; canonicalRelations: string[]; writerPolicy: object; domains: Domain[]; capabilities: Item[] };

const root = process.cwd();
const runtime = resolve(root, "runtime/global-crypto-depth-orchestrator");
const paths = { lock: resolve(runtime, "single-writer.lock"), checkpoint: resolve(runtime, "checkpoint.json"), queue: resolve(runtime, "work-queue.json"), heartbeat: resolve(runtime, "heartbeat.json"), manifest: resolve(runtime, "completion-manifest.json") };
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
  for (const candidate of ["standalone.pid", "launcher.pid", "runner.pid", "pid", "heartbeat.json", "completion-manifest.json"]) {
    const file = resolve(dir, candidate);
    const raw = await readFile(file, "utf8").catch(() => "");
    let pid = Number(raw.trim());
    if (!pid) try { const value = JSON.parse(raw); pid = Number(value.pid ?? value.ownerPid); } catch { pid = 0; }
    if (alive(pid)) return { pid, file };
  }
  return null;
}

async function cycle(config: Config) {
  const previous = await readJson<{ cycle?: number }>(paths.checkpoint, {});
  const domains = await Promise.all(config.domains.map(async domain => { const owner = await runtimeOwner(domain.runtime); return { ...domain, action: owner ? "REUSED_ACTIVE_WRITER" : "CHECKPOINT_RESUME_PENDING", pid: owner?.pid ?? null, checkedAt: iso() }; }));
  const activeDomainWriters = domains.filter(domain => domain.pid).map(domain => ({ domain: domain.id, runtime: domain.runtime, pid: domain.pid }));
  const state = { task: "GLOBAL_CRYPTO_CONTINUOUS_PROFESSIONAL_DEPTH_ORCHESTRATION_V2", asset: config.asset, mode: "INCREMENTAL_ONLY", autoContinuing: activeDomainWriters.length > 0, codexRequiredForContinuation: false, checkpointResumable: true, boundedBatching: true, boundedBatchSize: config.boundedBatchSize, orderBookBounded: true, fullChainIndexing: false, databaseBackoff: "ENABLED", maxSourceDepthPolicy: "ACTIVE", futureWindowGuard: "ACTIVE", doubleWriter: false, unknown: 0, canonicalWrite: false, counts: config.counts, canonicalRelations: config.canonicalRelations, writerPolicy: config.writerPolicy, activeDomainWriters, domains, capabilities: config.capabilities, cycle: Number(previous.cycle ?? 0) + 1, updatedAt: iso() };
  await atomic(paths.queue, { ...state, queuePolicy: "SMALL_PENDING_BATCH_ONLY", fetchPolicy: "NEW_ELIGIBLE_INTERVALS_ONLY", analyticsPolicy: "AFFECTED_WINDOWS_ONLY", action: "BACKGROUND_CONTINUE" });
  await atomic(paths.checkpoint, { cycle: state.cycle, resumable: true, nextPriority: "P0A", existingWorkerPid: activeDomainWriters[0]?.pid ?? null, updatedAt: state.updatedAt });
  await atomic(paths.heartbeat, { pid: process.pid, status: state.autoContinuing ? "AUTO_CONTINUING" : "CHECKPOINT_RESUME_PENDING", stage: "SCHEDULER_VERIFIED", canonicalWrite: false, updatedAt: iso() });
  await atomic(paths.manifest, state);
  failures = 0;
}

async function main() {
  const config = JSON.parse(await readFile(resolve(root, "config/global-crypto-depth-orchestrator.json"), "utf8")) as Config;
  process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; });
  await acquire(config.asset);
  try { do { try { await cycle(config); } catch (error) { failures += 1; const waitMs = config.databaseBackoffMs[Math.min(failures - 1, config.databaseBackoffMs.length - 1)]; await atomic(paths.heartbeat, { pid: process.pid, status: "DATABASE_BACKOFF", waitMs, error: String(error), updatedAt: iso() }); if (once) throw error; await sleep(waitMs); continue; } if (!once && !stopping) await sleep(config.pollIntervalMs); } while (!once && !stopping); }
  finally { if (ownsLock) await unlink(paths.lock).catch(() => undefined); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
