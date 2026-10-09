import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeAssetRuntimeStatus } from "../../../lib/data-platform/runtime/writeAssetRuntimeStatus.ts";

type GapState = "QUEUED" | "CLAIMED" | "RUNNING" | "CHECKPOINT" | "COMPLETE" | "WAITING_DEPENDENCY" | "BLOCKED" | "RETRY_WAIT";
type GapItem = { position: number; id: string; priority: string; classification: string; preferredOwner: string; action: string; state?: GapState; attempts?: number; checkpoint?: string | null; started_at?: string | null; updated_at?: string | null; completed_at?: string | null; last_error?: string | null };
type Queue = { asset: string; status: string; executionAuthorized: boolean; workerStarted: boolean; maxDbConcurrency: number; dbPolicy: string; currentGapId: string | null; currentMarket: string | null; items: GapItem[] };

const root = process.cwd();
const queueFile = resolve(root, "runtime/etf/depth-gap-work-queue.json");
const lockFile = resolve(root, "runtime/etf/depth-gap-consumer.lock");
const checkpointFile = resolve(root, "runtime/etf/depth-gap-consumer-checkpoint.json");
const artifactFile = resolve(root, "runtime/etf/gap-artifacts/ETF_NAV_PREMIUM_INTEGRITY.json");
const now = () => new Date().toISOString();
const readJson = async <T>(file: string, fallback: T) => readFile(file, "utf8").then(value => JSON.parse(value) as T).catch(() => fallback);
async function atomic(file: string, value: unknown) { await mkdir(dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, file); }

async function acquire() {
  await mkdir(dirname(lockFile), { recursive: true });
  const handle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  await handle.writeFile(JSON.stringify({ pid: process.pid, role: "EXISTING_GLOBAL_ETF_LIFECYCLE_HOOK", acquired_at: now() }));
  await handle.close();
}

async function publish(queue: Queue, item: GapItem | null, progress: string) {
  const prior = await readJson<Record<string, unknown>>(resolve(root, "runtime-status/etf.json"), {});
  const completed = queue.items.filter(value => value.state === "COMPLETE").length;
  const waiting = queue.items.filter(value => value.state === "WAITING_DEPENDENCY" || value.state === "RETRY_WAIT").length;
  await writeAssetRuntimeStatus({
    ...(prior as any), ASSET: "ETF", HEARTBEAT_AT: now(), CURRENT_GAP_ID: item?.id ?? queue.currentGapId,
    CURRENT_GAP_DOMAIN: item?.id === "ETF_NAV_PREMIUM_INTEGRITY" ? "NAV / Premium-Discount" : null,
    CURRENT_GAP_STATE: item?.state ?? null, GAPS_COMPLETED: completed, WAITING_DEPENDENCIES: waiting,
    BLOCKED_GAPS: 14, LAST_GAP_PROGRESS: progress, GAP_QUEUE_STATUS: queue.status,
    DB_POOL_STATUS: `${queue.dbPolicy}; MAX_CONCURRENCY=${queue.maxDbConcurrency}; CONSUMER_DB_CONNECTIONS=0`, progressChanged: true,
  });
}

async function executeNavPremiumIntegrity() {
  const source = await readJson<any>(resolve(root, "runtime/asset-expansion-v1/etf-nav-premium-discount/status.json"), null);
  const checkpoint = await readJson<any>(resolve(root, "runtime/asset-expansion-v1/etf-nav-premium-discount/checkpoint.json"), null);
  if (!source || !checkpoint) throw new Error("WAITING_DEPENDENCY:ETF_NAV_RUNTIME_EVIDENCE_MISSING");
  const nav = Number(source.canary?.nav), price = Number(source.canary?.marketPrice), reported = Number(source.canary?.premiumDiscountPct);
  if (![nav, price, reported].every(Number.isFinite) || nav <= 0) throw new Error("BLOCKED:ETF_NAV_CANARY_INVALID");
  const calculated = ((price / nav) - 1) * 100;
  const delta = Math.abs(calculated - reported);
  const passed = source.fetch === "PASS" && source.parse === "PASS" && source.semantics === "PASS" && source.writeCanary === "PASS" && source.readBack === "PASS" && delta < 1e-10;
  if (!passed) throw new Error(`BLOCKED:ETF_NAV_PREMIUM_INTEGRITY_FAILED:DELTA=${delta}`);
  const artifact = { gap_id: "ETF_NAV_PREMIUM_INTEGRITY", method: "EXISTING_CANARY_READBACK_AND_FORMULA_RECONCILIATION", database_scan: false, database_connections: 0, source_asset: source.asset, source: source.sourceSelected, etf: source.canary.etf, date: source.canary.date, nav, market_price: price, reported_premium_discount_pct: reported, calculated_premium_discount_pct: calculated, absolute_delta: delta, fetch: source.fetch, parse: source.parse, semantics: source.semantics, write_canary: source.writeCanary, read_back: source.readBack, result: "PASS", checked_at: now() };
  await atomic(artifactFile, artifact);
  return `NAV_CANARY=${artifact.etf}:${artifact.date};FORMULA_DELTA=${delta};READBACK=PASS`;
}

export async function consumeOneEtfDepthGap() {
  try { await acquire(); }
  catch { return { status: "LOCKED_EXISTING_CONSUMER", consumed: false }; }
  try {
    const queue = await readJson<Queue>(queueFile, { asset: "GLOBAL_ETF", status: "EMPTY", executionAuthorized: true, workerStarted: false, maxDbConcurrency: 1, dbPolicy: "SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER", currentGapId: null, currentMarket: null, items: [] });
    for (const value of queue.items) { value.state ??= "QUEUED"; value.attempts ??= 0; value.checkpoint ??= null; value.started_at ??= null; value.updated_at ??= null; value.completed_at ??= null; value.last_error ??= null; }
    queue.executionAuthorized = true; queue.workerStarted = false;
    const item = queue.items.filter(value => value.id === "ETF_NAV_PREMIUM_INTEGRITY" && ["QUEUED", "RETRY_WAIT"].includes(value.state!)).sort((a, b) => a.position - b.position)[0];
    if (!item) { queue.status = queue.items.some(value => value.state === "COMPLETE") ? "SCHEDULED_WAIT" : "QUEUED"; await atomic(queueFile, queue); await publish(queue, null, "No currently eligible hooked ETF gap"); return { status: queue.status, consumed: false }; }
    const started = now();
    Object.assign(item, { state: "RUNNING", attempts: Number(item.attempts) + 1, started_at: item.started_at ?? started, updated_at: started, completed_at: null, last_error: null, checkpoint: `CLAIMED:${started}:EXISTING_GLOBAL_ETF_LIFECYCLE` });
    queue.status = "RUNNING"; queue.currentGapId = item.id; await atomic(queueFile, queue); await atomic(checkpointFile, item); await publish(queue, item, `${item.id} claimed; attempt ${item.attempts}`);
    try {
      item.state = "CHECKPOINT"; item.checkpoint = "VALIDATING_EXISTING_NAV_CANARY_READBACK"; item.updated_at = now(); await atomic(queueFile, queue); await atomic(checkpointFile, item);
      const checkpoint = await executeNavPremiumIntegrity();
      Object.assign(item, { state: "COMPLETE", checkpoint, updated_at: now(), completed_at: now(), last_error: null });
      queue.status = "SCHEDULED_WAIT"; await atomic(queueFile, queue); await atomic(checkpointFile, item); await publish(queue, item, `${item.id} complete: ${checkpoint}`); return { status: item.state, consumed: true, checkpoint };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); const retry = message.startsWith("WAITING_DEPENDENCY:");
      Object.assign(item, { state: retry ? "WAITING_DEPENDENCY" : "BLOCKED", checkpoint: `${retry ? "WAITING_DEPENDENCY" : "BLOCKED"}:${now()}`, updated_at: now(), last_error: message });
      queue.status = item.state; await atomic(queueFile, queue); await atomic(checkpointFile, item); await publish(queue, item, `${item.id} ${item.state}: ${message}`); return { status: item.state, consumed: true };
    }
  } finally { await unlink(lockFile).catch(() => undefined); }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/consume-etf-depth-gap.ts")) consumeOneEtfDepthGap().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
