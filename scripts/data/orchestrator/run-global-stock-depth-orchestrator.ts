import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

type TerminalStatus = "MAX_SOURCE_DEPTH_REACHED" | "CURRENT_AND_AUTO_UPDATING" | "SOURCE_CONSTRAINED" | "ACCESS_CONSTRAINED" | "LICENSE_CONSTRAINED" | "TIME_DEPTH_CONSTRAINED" | "MAPPING_CONSTRAINED" | "CONFIGURATION_CONSTRAINED" | "SCHEMA_BLOCKED";
type Domain = { id: string; priority: "P0A" | "P0B" | "P1"; status: TerminalStatus; runtime?: string; start?: string; delegate?: string };
type Config = { version: number; asset: string; pollIntervalMs: number; databaseBackoffMs: number[]; domains: Domain[] };

const root = process.cwd();
const runtime = resolve(root, "runtime/global-stock-depth-orchestrator");
const paths = { lock: resolve(runtime, "single-writer.lock"), checkpoint: resolve(runtime, "checkpoint.json"), queue: resolve(runtime, "work-queue.json"), heartbeat: resolve(runtime, "heartbeat.json"), manifest: resolve(runtime, "completion-manifest.json"), publicStatus: resolve(root, "runtime-status/global-stock.json") };
let config: Config;
const once = process.argv.includes("--once");
let ownsLock = false;
let stopping = false;
let dbFailures = 0;
const iso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const readJson = async <T>(file: string, fallback: T) => readFile(file, "utf8").then(text => JSON.parse(text) as T).catch(() => fallback);
async function atomic(file: string, value: unknown) { await mkdir(dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, file); }

type StockProgress = { current_stage?: string; current_country?: string | null; rows?: number; coverage?: { completed?: number; total?: number | null }; updated_at?: string };
async function publishStatus(rows: Array<Domain & { action: string; pid: number | null; checkedAt: string }>, runState: "SCHEDULED_WAIT" | "BLOCKED", blocker: unknown = null) {
  const progress = await readJson<StockProgress>(resolve(root, "runtime/automation/global-stock-p0-depth/progress.json"), {});
  const manifest = await readJson<{ gaps?: Array<{ gap_id: string; priority: string; deterministic_possible: boolean; status: string }> }>(resolve(root, "runtime/global-stock-gap-manifest.json"), {});
  const gapQueue = await readJson<{ current_gap_id?: string; current_gap_domain?: string; current_market_gap?: string; queue_status?: string; items?: Array<{ status: string }> }>(resolve(runtime, "gap-queue.json"), {});
  const gaps = manifest.gaps ?? [];
  const active = rows.find(row => row.pid && alive(row.pid));
  const now = Date.now();
  await atomic(paths.publicStatus, {
    asset: config.asset,
    current_phase: "CONTINUOUS_DEPTH_ORCHESTRATION",
    current_layer: progress.current_stage ?? active?.priority ?? null,
    current_task: active?.id ?? "SCHEDULER_WAIT",
    current_market: progress.current_country ?? null,
    processed: progress.coverage?.completed ?? progress.rows ?? 0,
    total: progress.coverage?.total ?? null,
    run_state: runState,
    process_id: process.pid,
    heartbeat_at: iso(),
    last_progress_at: progress.updated_at ?? null,
    last_progress: progress.coverage ?? { completed: progress.rows ?? 0, total: null },
    blocker,
    next: "BACKGROUND_CONTINUE",
    next_run_at: new Date(now + (runState === "BLOCKED" ? config.databaseBackoffMs[Math.min(dbFailures - 1, config.databaseBackoffMs.length - 1)] : config.pollIntervalMs)).toISOString(),
    quote_status: rows.find(row => row.id === "CURRENT_QUOTE")?.status ?? "CONFIGURATION_CONSTRAINED",
    DEPTH_AUDIT_STATUS: gaps.length ? "COMPLETE" : "NOT_AVAILABLE",
    DEPTH_GAPS_TOTAL: gaps.length,
    DEPTH_GAPS_P0: gaps.filter(gap => gap.priority === "P0").length,
    DEPTH_GAPS_P1: gaps.filter(gap => gap.priority === "P1").length,
    DEPTH_GAPS_P2: gaps.filter(gap => gap.priority === "P2").length,
    DEPTH_GAPS_P3: gaps.filter(gap => gap.priority === "P3").length,
    DETERMINISTIC_GAPS_TOTAL: gaps.filter(gap => gap.deterministic_possible).length,
    BLOCKED_GAPS_TOTAL: gaps.filter(gap => gap.status === "BLOCKED").length,
    CURRENT_GAP_ID: gapQueue.current_gap_id ?? null,
    CURRENT_GAP_DOMAIN: gapQueue.current_gap_domain ?? null,
    CURRENT_MARKET_GAP: gapQueue.current_market_gap ?? null,
    GAPS_COMPLETED: (gapQueue.items ?? []).filter(item => item.status === "COMPLETE").length,
    LAST_GAP_PROGRESS: null,
    GAP_QUEUE_STATUS: gapQueue.queue_status ?? "NOT_AVAILABLE",
    continuing: true,
  });
}

async function acquire() {
  await mkdir(runtime, { recursive: true });
  try { const handle = await open(paths.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY); await handle.writeFile(JSON.stringify({ pid: process.pid, asset: config.asset, acquiredAt: iso() })); await handle.close(); ownsLock = true; }
  catch { const owner = await readJson<{pid?: number}>(paths.lock, {}); if (alive(owner.pid)) throw new Error(`DOUBLE_WRITER:${owner.pid}`); await unlink(paths.lock).catch(() => undefined); return acquire(); }
}

async function runtimeOwner(domain: Domain) {
  if (!domain.runtime) return null;
  const dir = resolve(root, "runtime", domain.runtime);
  for (const name of ["supervisor.pid", "global-reit.pid", "pid", "pid.json", "single-writer.lock", "runner.lock.json"]) {
    const file = resolve(dir, name); const raw = await readFile(file, "utf8").catch(() => "");
    const pid = Number(raw.trim()) || Number((() => { try { return JSON.parse(raw).pid; } catch { return 0; } })());
    if (alive(pid)) return { pid, file };
  }
  return null;
}

async function launch(domain: Domain) {
  if (!domain.start || domain.delegate) return { action: "CLASSIFIED", pid: null };
  if (await runtimeOwner(domain)) return { action: "REUSED_ACTIVE_WRITER", pid: (await runtimeOwner(domain))!.pid };
  await access(resolve(root, domain.start));
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(root, domain.start)], { cwd: root, detached: true, windowsHide: true, stdio: "ignore" });
  child.unref();
  return { action: "STARTED_EXISTING_SUPERVISOR", pid: child.pid ?? null };
}

async function cycle() {
  config = JSON.parse(await readFile(resolve(root, "config/global-stock-depth-orchestrator.json"), "utf8")) as Config;
  const prior = await readJson<{ cycle?: number }>(paths.checkpoint, { cycle: 0 });
  const rows = [];
  for (const domain of config.domains) {
    const owner = await runtimeOwner(domain);
    let action = owner ? "REUSED_ACTIVE_WRITER" : "CLASSIFIED"; let pid = owner?.pid ?? null;
    if (!owner && domain.start && !domain.delegate && domain.status === "CURRENT_AND_AUTO_UPDATING") { const launched = await launch(domain); action = launched.action; pid = launched.pid; await sleep(1000); }
    rows.push({ ...domain, action, pid, checkedAt: iso() });
  }
  const counts = Object.fromEntries(["P0A", "P0B", "P1"].map(priority => [priority, rows.filter(row => row.priority === priority && !row.status).length]));
  const state = { asset: config.asset, mode: "INCREMENTAL_ONLY", autoContinuing: true, boundedBatching: true, databaseBackoff: "ENABLED", doubleWriter: false, unknown: 0, cycle: Number(prior.cycle ?? 0) + 1, counts, domains: rows, updatedAt: iso() };
  await atomic(paths.queue, state); await atomic(paths.checkpoint, { cycle: state.cycle, updatedAt: state.updatedAt }); await atomic(paths.heartbeat, { pid: process.pid, status: "AUTO_CONTINUING", stage: "SCHEDULER_WAIT", updatedAt: iso() }); await atomic(paths.manifest, state);
  await publishStatus(rows, "SCHEDULED_WAIT");
  dbFailures = 0;
}

async function main() {
  config = JSON.parse(await readFile(resolve(root, "config/global-stock-depth-orchestrator.json"), "utf8")) as Config;
  process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; });
  await acquire();
  try {
    do { try { await cycle(); } catch (error) { dbFailures += 1; const waitMs = config.databaseBackoffMs[Math.min(dbFailures - 1, config.databaseBackoffMs.length - 1)]; await atomic(paths.heartbeat, { pid: process.pid, status: "DATABASE_BACKOFF", waitMs, error: String(error), updatedAt: iso() }); const rows = (await readJson<{ domains?: Array<Domain & { action: string; pid: number | null; checkedAt: string }> }>(paths.queue, {})).domains ?? []; await publishStatus(rows, "BLOCKED", String(error)); if (once) throw error; await sleep(waitMs); continue; } if (!once && !stopping) await sleep(config.pollIntervalMs); } while (!once && !stopping);
  } finally { if (ownsLock) await unlink(paths.lock).catch(() => undefined); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
