import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { adapterRegistry } from "./official-basket-common-adapter.ts";

const ROOT = process.cwd(), DIR = resolve(ROOT, "runtime", "etf-public-expansion");
const CONFIG = resolve(ROOT, "config", "etf-public-source-expansion.json");
const now = () => new Date().toISOString();
async function json(file: string, fallback: any = null) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } }
async function atomic(file: string, value: unknown) { await mkdir(DIR, { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + "\n"); await rename(temporary, file); }
async function alive(pid: unknown) { if (!Number(pid)) return false; try { process.kill(Number(pid), 0); return true; } catch { return false; } }

async function idleGate() {
  const reasons: string[] = [];
  const holdingsPid = Number((await readFile(resolve(ROOT, "runtime", "etf-holdings", "supervisor.pid"), "utf8").catch(() => "0")).trim());
  const flowProcess = await json(resolve(ROOT, "runtime", "etf-flows", "process.json"), {});
  if (await alive(holdingsPid)) reasons.push(`ETF_HOLDINGS_RUNNING:${holdingsPid}`);
  if (await alive(flowProcess.pid)) reasons.push(`ETF_FLOWS_RUNNING:${flowProcess.pid}`);
  const status = await json(resolve(ROOT, "runtime-status", "etf.json"), {});
  if (["RUNNING", "STALLED"].includes(status.RUN_STATE)) reasons.push(`ETF_RUNTIME_${status.RUN_STATE}`);
  const gap = await json(resolve(ROOT, "runtime", "etf", "depth-gap-work-queue.json"), {});
  if (["RUNNING", "QUEUED", "CLAIMABLE_WORK", "RETRY_WAIT"].includes(gap.status ?? gap.GAP_QUEUE_STATUS)) reasons.push(`ETF_GAP_${gap.status ?? gap.GAP_QUEUE_STATUS}`);
  const sec = await json(resolve(ROOT, "runtime", "sec-investment-company", "checkpoint.json"), {});
  if (["RUNNING", "RECOVERY_PENDING", "CHECKPOINT_RESUME_PENDING", "HISTORICAL_PENDING", "INCREMENTAL_PENDING"].includes(sec.state ?? sec.status)) reasons.push(`SEC_SHARED_${sec.state ?? sec.status}`);
  return { idle: reasons.length === 0, reasons };
}

export async function runPublicSourceExpansion() {
  const config = await json(CONFIG); if (!config) throw new Error("EXPANSION_CONFIG_MISSING");
  for (const source of config.sources) if (!adapterRegistry.has(source.adapter)) throw new Error(`UNREGISTERED_ADAPTER:${source.adapter}`);
  const gate = await idleGate(), at = now();
  const workItems = config.sources.map((source: any) => ({ id: source.id, market: source.market, adapter: source.adapter, priority: config.priority, state: gate.idle ? "QUEUED_IDLE_CLAIMABLE" : "WAIT_BACKOFF", attempts: 0, checkpoint: null, lastError: null, fullUniverse: true, fullHistory: true }));
  const queue = { asset: config.asset, owner: "ETF_PUBLIC_SOURCE_EXPANSION_ORDINARY_NODE", priority: config.priority, existingEtfPriority: config.existingEtfPriority, idleOnly: true, gate, state: gate.idle ? "QUEUED_IDLE_CLAIMABLE" : "WAIT_BACKOFF", nextRunAt: gate.idle ? at : new Date(Date.now() + 15 * 60_000).toISOString(), maxDbConcurrency: 1, isolatedCheckpoints: true, workItems, updatedAt: at };
  await atomic(resolve(DIR, "work-queue.json"), queue);
  await atomic(resolve(DIR, "source-registry.json"), { sources: config.sources, basketLifecycle: config.basketLifecycle, themeEvidence: config.themeEvidence, identity: config.identity, currencyHedgeAnalytics: config.currencyHedgeAnalytics, leveragedInverse: config.leveragedInverse, securitiesLending: config.securitiesLending, verifiedBidAsk: config.verifiedBidAsk, us: config.us, euUcits: config.euUcits, dedup: config.dedup, multilingual: config.multilingual, registeredAt: at });
  const checkpoint = { asset: config.asset, state: queue.state, idleOnlyGate: gate, priority: 9, originalCheckpointsPreserved: true, existingEtfProcessesPreserved: true, fullUniverseAssigned: true, fullHistoryAssigned: true, ordinaryBackgroundWorker: "REGISTERED_IDLE_ONLY", codexDataRunning: false, updatedAt: at };
  await atomic(resolve(DIR, "checkpoint.json"), checkpoint);
  const readback = await json(resolve(DIR, "checkpoint.json")); if (readback?.priority !== 9 || readback?.idleOnlyGate?.idle !== gate.idle) throw new Error("EXPANSION_READBACK_FAILED");
  return { ...checkpoint, readback: "PASS", routes: workItems.length };
}

runPublicSourceExpansion().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
