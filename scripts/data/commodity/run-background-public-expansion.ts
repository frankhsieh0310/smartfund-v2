import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type Item = { id: string; source: string; owner: string | null; adapter: string; state: string; scope: string };
type Config = { priority: number; idleOnly: boolean; maxDbConcurrency: number; backoffMs: number; ownershipPolicy: string; workItems: Item[] };
const root = process.cwd();
const runtime = path.join(root, "runtime", "commodity", "background-public-expansion");
const checkpointPath = path.join(runtime, "checkpoint.json");
const heartbeatPath = path.join(runtime, "heartbeat.json");
const lockPath = path.join(runtime, "single-writer.lock");
const config: Config = JSON.parse(await readFile(path.join(root, "config", "commodity-background-public-expansion.json"), "utf8"));
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function atomic(file: string, value: unknown) { await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, file); }
async function json(file: string) { try { return JSON.parse(await readFile(path.join(root, file), "utf8")); } catch { return null; } }
async function idleGate() {
  const reasons: string[] = [];
  const supervisor = await json("runtime/commodity/desktop-supervisor/health.json");
  const gaps = await json("runtime/commodity/depth-gap-work-queue.json");
  const official = await json("runtime/commodity/official-completion/checkpoint.json");
  const usgs = await json("runtime/commodity/usgs-minerals/checkpoint.json");
  if (!supervisor || !gaps || !official || !usgs) reasons.push("IDLE_STATE_UNCERTAIN");
  if (supervisor?.queueState?.RUNNING > 0 || supervisor?.queueState?.PENDING > 0) reasons.push("EXISTING_QUEUE_ACTIVE");
  if (Array.isArray(gaps?.items) && gaps.items.some((x: { state: string }) => ["PENDING","RUNNING","RETRY_WAIT"].includes(x.state))) reasons.push("GAP_WORK_CLAIMABLE");
  if (Object.values(official?.states ?? {}).some((state) => ["AUTO_CONTINUING","RUNNING","RETRY_WAIT"].includes(String(state)))) reasons.push("OFFICIAL_COMPLETION_PENDING");
  if (["AUTO_CONTINUING","RUNNING","RETRY_WAIT"].includes(usgs?.state)) reasons.push("USGS_RESUME_PENDING");
  const nextRun = Date.parse(supervisor?.scheduler?.nextRun ?? "");
  if (Number.isFinite(nextRun) && nextRun <= Date.now()) reasons.push("SCHEDULED_WORK_DUE");
  return { idle: reasons.length === 0, reasons };
}
async function main() {
  if (!config.idleOnly || config.priority !== 9 || config.maxDbConcurrency !== 1 || Number(process.env.MAX_DB_CONCURRENCY ?? "1") !== 1) throw new Error("BACKGROUND_POLICY_VIOLATION");
  await mkdir(runtime, { recursive: true }); const handle = await open(lockPath, "wx"); await handle.writeFile(JSON.stringify({ pid: process.pid, owner: "ordinary-background-worker", priority: 9, startedAt: now() })); await handle.close();
  try {
    do {
      const gate = await idleGate();
      if (!gate.idle) {
        const state = { asset: "COMMODITY", priority: 9, state: "WAIT_BACKOFF", claimed: null, reasons: gate.reasons, ownershipPolicy: config.ownershipPolicy, originalCheckpointsPreserved: true, updatedAt: now(), nextCheckAt: new Date(Date.now() + config.backoffMs).toISOString() };
        await atomic(checkpointPath, state); await atomic(heartbeatPath, { ...state, pid: process.pid, heartbeatAt: state.updatedAt }); await sleep(config.backoffMs); continue;
      }
      const previous = await json("runtime/commodity/background-public-expansion/checkpoint.json");
      const completed: string[] = previous?.completed ?? [];
      const item = config.workItems.find((x) => !completed.includes(x.id) && !["EXTERNALLY_BLOCKED_LICENSE","INPUT_GATED_DATA_VOLUME_GATED"].includes(x.state));
      if (!item) { await atomic(heartbeatPath, { asset: "COMMODITY", priority: 9, state: "HEALTHY_WAITING", pid: process.pid, heartbeatAt: now() }); await sleep(config.backoffMs); continue; }
      // Claiming is deliberately separate from execution. Source adapters consume this isolated work item
      // through the existing deterministic lifecycle; the background router never touches Priority-0 checkpoints.
      await atomic(checkpointPath, { asset: "COMMODITY", priority: 9, state: "CLAIMABLE_IDLE", currentWorkItem: item, completed, ownershipPolicy: config.ownershipPolicy, originalCheckpointsPreserved: true, updatedAt: now() });
      await atomic(heartbeatPath, { asset: "COMMODITY", priority: 9, state: "CLAIMABLE_IDLE", currentWorkItem: item.id, pid: process.pid, heartbeatAt: now() });
      await sleep(config.backoffMs);
    } while (true);
  } finally { await rm(lockPath, { force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
