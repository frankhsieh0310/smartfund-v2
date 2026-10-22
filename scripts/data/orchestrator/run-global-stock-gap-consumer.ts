import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Gap = { gap_id: string; domain: string; priority: string; deterministic_possible: boolean; target_worker: string | null; checkpoint: string | null; blocker: string | null; status: string };
type Manifest = { gaps: Gap[] };
type ItemState = { gap_id: string; owner: string | null; state: "PENDING" | "OWNERSHIP_DELEGATED" | "RUNNING" | "RETRY_WAIT" | "BLOCKED" | "WAITING_DEPENDENCY" | "COMPLETE"; attempts: number; checkpoint: string | null; started_at: string | null; updated_at: string; completed_at: string | null; last_error: string | null };

const root = process.cwd();
const runtime = resolve(root, "runtime/global-stock-depth-orchestrator");
const manifestPath = resolve(root, "runtime/global-stock-gap-manifest.json");
const statePath = resolve(runtime, "gap-consumer-state.json");
const queuePath = resolve(runtime, "gap-queue.json");
const lockPath = resolve(runtime, "gap-consumer.lock");
const statusPath = resolve(root, "runtime-status/global-stock.json");
const identityEvidencePath = resolve(root, "runtime/global-stock/p0-canonical-core-classification-v1/completion-manifest.json");
const once = process.argv.includes("--once");
const pollMs = 60_000;
let ownsLock = false;
let stopping = false;
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const read = async <T>(file: string, fallback: T) => readFile(file, "utf8").then(text => JSON.parse(text) as T).catch(() => fallback);
async function atomic(file: string, value: unknown) { await mkdir(dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, file); }
function alive(pid?: number) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
async function acquire() { await mkdir(runtime, { recursive: true }); try { const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY); await handle.writeFile(JSON.stringify({ pid: process.pid, role: "GLOBAL_STOCK_GAP_CONSUMER", acquired_at: now() })); await handle.close(); ownsLock = true; } catch { const owner = await read<{pid?: number}>(lockPath, {}); if (alive(owner.pid)) throw new Error(`GAP_CONSUMER_ALREADY_ACTIVE:${owner.pid}`); await unlink(lockPath).catch(() => undefined); return acquire(); } }

const blocked = (gap: Gap) => gap.status === "BLOCKED" || ["BLOCKED_SCHEMA", "BLOCKED_SOURCE", "BLOCKED_LICENSE", "BLOCKED_AUTH"].includes(gap.blocker ?? "");
const eligible = (gap: Gap) => gap.deterministic_possible && !blocked(gap);
const dependency: Record<string, string[]> = {
  "GS-P1-FINANCIAL-DEPTH": ["GS-P0-IDENTITY-BRIDGE"], "GS-P1-CORPORATE-ACTION-DEPTH": ["GS-P0-IDENTITY-BRIDGE"],
  "GS-P1-VALUATION-HISTORY": ["GS-P0-IDENTITY-BRIDGE", "GS-P1-FINANCIAL-DEPTH", "GS-P1-CORPORATE-ACTION-DEPTH"],
  "GS-P2-ETF-FUND-REVERSE": ["GS-P0-IDENTITY-BRIDGE"], "GS-P2-EVENT-REACTION": ["GS-P0-IDENTITY-BRIDGE", "GS-P1-CORPORATE-ACTION-DEPTH"],
  "GS-P2-DATA-TRUST-MASTER": ["GS-P0-IDENTITY-BRIDGE"], "GS-P3-SHARPE-SORTINO-SEASONALITY": ["GS-P1-FINANCIAL-DEPTH", "GS-P1-VALUATION-HISTORY"]
};

async function execute(gap: Gap): Promise<{ state: ItemState["state"]; checkpoint: string; error: string | null }> {
  if (gap.gap_id === "GS-P0-IDENTITY-BRIDGE") {
    const evidence = await read<{ bridgePrerequisite?: { stockSecurityIdColumnPresent?: boolean; state?: string }; stockCanonicalBridgeStatus?: string }>(identityEvidencePath, {});
    const checkpoint = `schema_column=${Boolean(evidence.bridgePrerequisite?.stockSecurityIdColumnPresent)};bridge=${evidence.bridgePrerequisite?.state ?? "UNKNOWN"};governance=${evidence.stockCanonicalBridgeStatus ?? "UNKNOWN"}`;
    if (!evidence.bridgePrerequisite?.stockSecurityIdColumnPresent) return { state: "BLOCKED", checkpoint, error: "BLOCKED_SCHEMA:stocks.security_id missing; migration not authorized" };
    return { state: "COMPLETE", checkpoint, error: null };
  }
  if (gap.target_worker === "railway-production" || gap.target_worker === "GLOBAL_CORPORATE_ACTIONS") return { state: "OWNERSHIP_DELEGATED", checkpoint: gap.checkpoint ?? "existing lifecycle", error: null };
  return { state: "WAITING_DEPENDENCY", checkpoint: gap.checkpoint ?? "dependency gate", error: null };
}

async function publish(items: ItemState[], current: ItemState | null) {
  const status = await read<Record<string, unknown>>(statusPath, {});
  const blockedItems = items.filter(item => item.state === "BLOCKED");
  const waiting = items.filter(item => item.state === "WAITING_DEPENDENCY").map(item => item.gap_id);
  await atomic(statusPath, { ...status, CURRENT_GAP_ID: current?.gap_id ?? null, CURRENT_GAP_STATE: current?.state ?? "SCHEDULED_WAIT", GAPS_COMPLETED: items.filter(item => item.state === "COMPLETE").length, LAST_GAP_PROGRESS: current ? { gap_id: current.gap_id, checkpoint: current.checkpoint, attempts: current.attempts, updated_at: current.updated_at } : null, GAP_QUEUE_STATUS: "AUTO_CONTINUING", DB_POOL_STATUS: "TRANSACTION_POOLING_PREFERRED_NO_DB_CONNECTION_USED", WAITING_DEPENDENCIES: waiting, BLOCKED_GAPS: blockedItems.map(item => ({ gap_id: item.gap_id, error: item.last_error })), continuing: true });
}

async function cycle() {
  const manifest = await read<Manifest>(manifestPath, { gaps: [] });
  const gaps = manifest.gaps.filter(eligible);
  const previous = await read<{ items?: ItemState[] }>(statePath, {});
  const prior = new Map((previous.items ?? []).map(item => [item.gap_id, item]));
  const stamp = now();
  const items = gaps.map(gap => prior.get(gap.gap_id) ?? { gap_id: gap.gap_id, owner: gap.target_worker, state: gap.status === "OWNERSHIP_DELEGATED" ? "OWNERSHIP_DELEGATED" : "PENDING", attempts: 0, checkpoint: gap.checkpoint, started_at: null, updated_at: stamp, completed_at: null, last_error: null });
  let current: ItemState | null = null;
  for (const gap of gaps) {
    const item = items.find(candidate => candidate.gap_id === gap.gap_id)!;
    if (["COMPLETE", "BLOCKED"].includes(item.state)) continue;
    const unmet = (dependency[gap.gap_id] ?? []).filter(id => items.find(candidate => candidate.gap_id === id)?.state !== "COMPLETE");
    if (unmet.length) { item.state = "WAITING_DEPENDENCY"; item.checkpoint = `waiting:${unmet.join(",")}`; item.updated_at = now(); continue; }
    if (gap.target_worker === "railway-production" || gap.target_worker === "GLOBAL_CORPORATE_ACTIONS") { const result = await execute(gap); item.state = result.state; item.checkpoint = result.checkpoint; item.updated_at = now(); current ??= item; continue; }
    item.state = "RUNNING"; item.attempts += 1; item.started_at ??= now(); item.updated_at = now(); current = item; await atomic(statePath, { asset: "GLOBAL_STOCK", pid: process.pid, max_db_concurrency: 1, db_pool_mode: "SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER", items, updated_at: now() });
    const result = await execute(gap); item.state = result.state; item.checkpoint = result.checkpoint; item.last_error = result.error; item.updated_at = now(); if (result.state === "COMPLETE") item.completed_at = now(); break;
  }
  current ??= items.find(item => item.state === "BLOCKED") ?? items.find(item => item.state === "WAITING_DEPENDENCY") ?? items.find(item => item.state === "OWNERSHIP_DELEGATED") ?? null;
  await atomic(statePath, { asset: "GLOBAL_STOCK", pid: process.pid, max_db_concurrency: 1, db_pool_mode: "SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER", historical_locks: ["UNIVERSE", "HISTORICAL_OHLCV", "LATEST_EOD", "SCHEDULER_RETRY_CHECKPOINT", "TECHNICAL_INDICATORS"], items, updated_at: now() });
  await atomic(queuePath, { asset: "GLOBAL_STOCK", mode: "DETERMINISTIC_ONLY", auto_continuing: true, current_gap_id: current?.gap_id ?? null, current_gap_state: current?.state ?? "SCHEDULED_WAIT", queue_status: "AUTO_CONTINUING", items, updated_at: now() });
  await publish(items, current);
}

async function main() { await acquire(); process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; }); try { do { await cycle(); if (!once && !stopping) await sleep(pollMs); } while (!once && !stopping); } finally { if (ownsLock) await unlink(lockPath).catch(() => undefined); } }
main().catch(error => { console.error(error); process.exitCode = 1; });
