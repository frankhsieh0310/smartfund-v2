import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type Route = { id: string; source: string; sourceOwner: string; consumers: string[]; adapter: string; vintageCapability: string; checkpoint: string };
type Config = { asset: string; existingMacroPriority: number; priority: number; explicitIdleMarker: string; database: { maxConcurrency: number }; executionTarget: Record<string, unknown>; canonicalDedup: Record<string, unknown>; vintageCapabilities: string[]; routes: Route[]; reuseOnly: string[]; multilingual: Record<string, unknown> };

const root = process.cwd();
const runtime = path.join(root, "runtime", "global-macro-background-public-expansion");

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(root, file), "utf8")) as T;
}

async function readOptional<T>(file: string): Promise<T | null> {
  try { return await readJson<T>(file); } catch { return null; }
}

async function atomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

async function main() {
  const config = await readJson<Config>("config/global-macro-background-public-expansion.json");
  const macro = await readOptional<{ RUN_STATE?: string }>("runtime-status/macro.json");
  const idleMarker = await readOptional<{ state?: string }>(config.explicitIdleMarker);
  const explicitlyIdle = idleMarker?.state === "EXPLICITLY_IDLE" && ["SCHEDULED_WAIT", "COMPLETE"].includes(macro?.RUN_STATE ?? "");
  const state = explicitlyIdle ? "QUEUED_IDLE_ONLY" : "WAIT_BACKOFF";
  const generatedAt = new Date().toISOString();
  const items = config.routes.map(route => ({
    id: route.id,
    state,
    priority: config.priority,
    source: route.source,
    sourceOwner: route.sourceOwner,
    consumers: route.consumers,
    adapter: route.adapter,
    vintageCapability: route.vintageCapability,
    checkpoint: route.checkpoint,
    maxDbConcurrency: config.database.maxConcurrency,
    fullUniverseAssigned: true,
    fullHistoryAssigned: true,
    claimed: false
  }));

  await atomic(path.join(runtime, "work-queue.json"), {
    asset: config.asset,
    existingMacroPriority: config.existingMacroPriority,
    priority: config.priority,
    idleOnly: true,
    state,
    claimedItems: 0,
    items,
    generatedAt
  });
  await atomic(path.join(runtime, "checkpoint.json"), {
    asset: config.asset,
    state,
    reason: explicitlyIdle ? "PRIORITY_0_EXPLICITLY_IDLE" : "PRIORITY_0_IDLE_NOT_EXPLICITLY_PROVEN",
    originalCheckpointsPreserved: true,
    isolatedExpansionCheckpoints: true,
    existingMacroProcessesPreserved: true,
    maxDbConcurrency: config.database.maxConcurrency,
    updatedAt: generatedAt
  });
  await atomic(path.join(runtime, "route-registry.json"), {
    asset: config.asset,
    ownershipRule: "ONE_PHYSICAL_SOURCE_ONE_INGESTION_OWNER_MANY_CONSUMERS",
    routes: items,
    reuseOnly: config.reuseOnly.map(id => ({ id, state: "ROUTED_SHARED_READ_ONLY", download: false })),
    canonicalDedup: config.canonicalDedup,
    vintageCapabilities: config.vintageCapabilities,
    multilingual: config.multilingual,
    executionTarget: config.executionTarget,
    generatedAt
  });
  console.log(JSON.stringify({ state, priority: config.priority, routes: items.length, claimedItems: 0, maxDbConcurrency: config.database.maxConcurrency }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
