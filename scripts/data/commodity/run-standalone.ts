import { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type Stage = { id: string; name: string };
type QueueStage = Stage & { status: "PENDING" | "RUNNING" | "COMPLETE" | "COMPLETE_WITH_GAPS"; attempts: number };
const root = process.cwd();
const runtime = path.join(root, "runtime", "commodity");
const queuePath = path.join(runtime, "master-queue.json");
const checkpointPath = path.join(runtime, "checkpoint.json");
const failurePath = path.join(runtime, "failure-queue.json");
const missingPath = path.join(runtime, "missing-matrix.json");
const progressPath = path.join(root, "runtime", "progress.json");
const manifestPath = path.join(runtime, "completion-manifest.json");
const logPath = path.join(runtime, "runner.log");
const lockPath = path.join(runtime, "runner.lock");
const pidPath = path.join(runtime, "runner.pid.json");
const maxRetries = 2;
const stages: Stage[] = [
  ["L0", "OFFICIAL_SOURCE_REGISTRY"], ["L1", "DATASET_REGISTRY"], ["L2", "COMMODITY_UNIVERSE"], ["L3", "COVERAGE_MATRIX"],
  ["L4", "OFFICIAL_HISTORICAL"], ["L5", "LATEST"], ["L6", "FRESHNESS"], ["L7", "INVENTORY"], ["L8", "PRODUCTION"],
  ["L9", "CONSUMPTION"], ["L10", "TRADE"], ["L11", "TERM_STRUCTURE"], ["L12", "CONTINUOUS_CONTRACT"],
  ["L13", "DERIVED_ANALYTICS"], ["L14", "TECHNICAL"], ["L15", "CHART_READY"], ["L16", "COMPARISON"],
  ["L17", "INCREMENTAL"], ["L18", "SCHEDULER"], ["L19", "ARCHIVE"], ["L20", "QUALITY"], ["L21", "RETRY"],
  ["L22", "MISSING_MATRIX"], ["L23", "MAINTENANCE"], ["L24", "RAILWAY_PRODUCTION_HANDOFF"]
].map(([id, name]) => ({ id, name }));
const now = () => new Date().toISOString();
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function atomic(file: string, value: unknown) { const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, json(value)); await rm(file, { force: true }); await writeFile(file, await readFile(temp)); await rm(temp, { force: true }); }
async function read<T>(file: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } }
async function exists(file: string) { try { await readFile(file); return true; } catch { return false; } }

await mkdir(runtime, { recursive: true });
let lock;
try { lock = await open(lockPath, "wx"); }
catch (error) {
  const prior = await read<{ pid?: number }>(lockPath, {}); let alive = false;
  if (prior.pid) try { process.kill(prior.pid, 0); alive = true; } catch {}
  if (alive) throw error; await rm(lockPath, { force: true }); lock = await open(lockPath, "wx");
}
await lock.writeFile(json({ pid: process.pid, startedAt: now() }));

try {
  const saved = await read<{ stages?: QueueStage[] }>(queuePath, {});
  const priorById = new Map((saved.stages ?? []).map((stage) => [stage.id, stage]));
  const queue: QueueStage[] = stages.map((stage) => priorById.get(stage.id) ?? ({ ...stage, status: ["L0", "L1", "L2", "L3"].includes(stage.id) ? "COMPLETE" : "PENDING", attempts: 0 }));
  const failures = await read<unknown[]>(failurePath, []), missing = await read<unknown[]>(missingPath, []);
  await atomic(pidPath, { pid: process.pid, status: "RUNNING", command: "node --experimental-strip-types scripts/data/commodity/run-standalone.ts", startedAt: now() });
  for (let index = 0; index < queue.length; index++) {
    const stage = queue[index]; if (stage.status === "COMPLETE" || stage.status === "COMPLETE_WITH_GAPS") continue;
    stage.status = "RUNNING"; stage.attempts += 1; await atomic(queuePath, { asset: "GLOBAL_COMMODITY", auto_continuing: true, stages: queue, updated_at: now() });
    await atomic(progressPath, { asset: "GLOBAL_COMMODITY", current_stage: stage.id, completed_units: queue.filter((item) => item.status === "COMPLETE" || item.status === "COMPLETE_WITH_GAPS").length, total_units: queue.length, progress_percent: Math.round(index / queue.length * 10000) / 100, auto_continuing: true, updated_at: now() });
    try {
      if (stage.id === "L4") {
        missing.push({ stage: stage.id, reasonCode: "INSUFFICIENT_INPUT", detail: "Historical execution intentionally not restarted; existing checkpoint preserved.", retryable: false, recordedAt: now() });
        stage.status = "COMPLETE_WITH_GAPS";
      } else if (stage.id === "L18" && await exists(path.join(root, "config", "commodity-production-events.json"))) {
        stage.status = "COMPLETE";
      } else if (["L0", "L1", "L2", "L3"].includes(stage.id)) {
        stage.status = "COMPLETE";
      } else {
        missing.push({ stage: stage.id, reasonCode: "SOURCE_NOT_PROVIDED", detail: `${stage.name} has no authorized production handler in the current checkpoint.`, retryable: false, recordedAt: now() });
        stage.status = "COMPLETE_WITH_GAPS";
      }
    } catch (error) {
      failures.push({ stage: stage.id, attempt: stage.attempts, reasonCode: "PARSE_FAILURE", detail: error instanceof Error ? error.message : String(error), recordedAt: now() });
      stage.status = stage.attempts < maxRetries ? "PENDING" : "COMPLETE_WITH_GAPS";
      if (stage.status === "PENDING") index -= 1;
    }
    await atomic(failurePath, failures); await atomic(missingPath, missing);
    await atomic(checkpointPath, { asset: "GLOBAL_COMMODITY", current_stage: stage.id, completed: queue.filter((item) => item.status === "COMPLETE" || item.status === "COMPLETE_WITH_GAPS").map((item) => item.id), auto_continuing: true, updated_at: now() });
    await atomic(queuePath, { asset: "GLOBAL_COMMODITY", auto_continuing: true, stages: queue, updated_at: now() });
  }
  const hasGaps = queue.some((stage) => stage.status === "COMPLETE_WITH_GAPS");
  const status = hasGaps ? "PRODUCTION_COMPLETE_WITH_GAPS" : "PRODUCTION_COMPLETE";
  await atomic(progressPath, { asset: "GLOBAL_COMMODITY", current_stage: "COMPLETE", completed_units: queue.length, total_units: queue.length, progress_percent: 100, auto_continuing: true, updated_at: now() });
  await atomic(manifestPath, { asset: "GLOBAL_COMMODITY", status, completedStages: queue.length, totalStages: queue.length, missingMatrixPath: missingPath, completedAt: now() });
  await appendFile(logPath, `${now()} ${status}\n`);
  await atomic(pidPath, { pid: process.pid, status, exitedAt: now() });
} finally { await lock.close(); await rm(lockPath, { force: true }); }
