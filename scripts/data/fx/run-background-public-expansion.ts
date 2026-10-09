import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const configFile = path.join(root, "config", "global-fx-background-public-expansion.json");
const runtimeRoot = path.join(root, "runtime", "fx", "public-expansion");
const queueFile = path.join(runtimeRoot, "queue.json");
const statusFile = path.join(runtimeRoot, "status.json");
const lockFile = path.join(runtimeRoot, "worker.lock");
const fxStatusFile = path.join(root, "runtime-status", "fx.json");
const now = () => new Date().toISOString();

async function json<T>(file: string, fallback: T): Promise<T> {
  return readFile(file, "utf8").then((value) => JSON.parse(value) as T).catch(() => fallback);
}
async function atomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function main(): Promise<void> {
  await mkdir(runtimeRoot, { recursive: true });
  let lock;
  try { lock = await open(lockFile, "wx"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    const config = await json<{ routes: Array<Record<string, unknown>> }>(configFile, { routes: [] });
    const existing = await json<Record<string, unknown>>(fxStatusFile, {});
    const prior = await json<{ items?: Array<Record<string, unknown>> }>(queueFile, { items: [] });
    const byId = new Map((prior.items ?? []).map((item) => [String(item.id), item]));
    const items = config.routes.map((route) => ({
      id: route.id,
      priority: 9,
      state: route.state,
      attempts: Number(byId.get(String(route.id))?.attempts ?? 0),
      checkpoint: route.checkpoint,
      claimed: false,
      updatedAt: now()
    }));
    const definitelyIdle = existing.RUN_STATE === "COMPLETE" && existing.CONTINUING !== "YES";
    const state = definitelyIdle ? "IDLE_CONFIRMED_HANDOFF_ELIGIBLE" : "WAITING_EXISTING_FX_IDLE";
    const status = {
      asset: "FX",
      worker: "FX_PUBLIC_BACKGROUND_NODE_WORKER",
      state,
      reason: definitelyIdle ? "ORDINARY_SOURCE_ADAPTERS_MAY_CLAIM_PRIORITY_9" : "IDLE_NOT_EXPLICITLY_CONFIRMED_FAIL_CLOSED",
      existingFxPriority: 0,
      expansionPriority: 9,
      existingRunState: existing.RUN_STATE ?? "UNKNOWN",
      existingContinuing: existing.CONTINUING ?? "UNKNOWN",
      existingProcessId: existing.PROCESS_ID ?? null,
      claimed: false,
      maxDbConcurrency: 1,
      updatedAt: now()
    };
    await atomic(queueFile, { asset: "FX", priority: 9, idleOnly: true, status: state, items, updatedAt: status.updatedAt });
    await atomic(statusFile, status);
    console.log(JSON.stringify(status));
  } finally {
    await lock.close(); await rm(lockFile, { force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
