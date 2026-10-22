import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateRoutes, type PublicRoute } from "./common-public-source-adapters.ts";

type Config = { version: string; asset: string; priority: number; existingStockPriority: number; idleOnly: boolean; failClosedWhenIdleUncertain: boolean; dbPool: string; maxDbConcurrency: number; neverHoldDbWhileWaitingNetwork: boolean; routes: PublicRoute[] };
const root = path.resolve("runtime", "stock-public-source-expansion");
const cpRoot = path.join(root, "checkpoints");
async function atomic(file: string, value: unknown) { await mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(tmp, file); }
const config = JSON.parse(await readFile(path.resolve("config", "global-stock-public-source-expansion.json"), "utf8")) as Config;
if (config.asset !== "GLOBAL_STOCK" || config.priority !== 9 || config.existingStockPriority !== 0 || !config.idleOnly || !config.failClosedWhenIdleUncertain || config.maxDbConcurrency !== 1) throw new Error("EXPANSION_SAFETY_CONTRACT_INVALID");
validateRoutes(config.routes);
const now = new Date().toISOString();
for (const route of config.routes) {
  const file = path.resolve(route.checkpoint);
  if (!file.startsWith(`${cpRoot}${path.sep}`)) throw new Error(`CHECKPOINT_ESCAPE:${route.id}`);
  await atomic(file, { routeId: route.id, state: route.state === "READY" ? "WAITING_FOR_IDLE" : route.state, attempts: 0, cursor: null, processed: 0, persisted: 0, lastError: null, nextRetryAt: null, createdAt: now, updatedAt: now, existingStockCheckpointTouched: false });
}
const adapters = [...new Set(config.routes.map((route) => route.adapter))];
const queue = { asset: config.asset, state: "READY_WAITING_FOR_IDLE", priority: config.priority, claimPolicy: "EXPLICIT_EXISTING_STOCK_IDLE_PROOF_REQUIRED", uncertainMeans: "DO_NOT_CLAIM", dbConnectionWhileWaiting: false, maxDbConcurrency: config.maxDbConcurrency, routes: config.routes.map(({ id, state, adapter, checkpoint, fullEligibleUniverse, deepestReliablePublicHistory, incremental, scheduledRefresh }) => ({ id, state, adapter, checkpoint, fullEligibleUniverse, deepestReliablePublicHistory, incremental, scheduledRefresh })), createdAt: now };
await atomic(path.join(root, "background-queue.json"), queue);
await atomic(path.join(root, "adapter-canary-readback.json"), { status: "PASS", canaryType: "LOCAL_CONTRACT_NO_REMOTE_DATA", adapters, adapterCount: adapters.length, routeCount: config.routes.length, checkpointsCreated: config.routes.length, networkCalls: 0, databaseWrites: 0, existingProcessesTouched: 0, existingCheckpointsTouched: 0, readbackAt: now });
const readback = JSON.parse(await readFile(path.join(root, "background-queue.json"), "utf8")) as typeof queue;
if (readback.routes.length !== config.routes.length || readback.claimPolicy !== "EXPLICIT_EXISTING_STOCK_IDLE_PROOF_REQUIRED") throw new Error("EXPANSION_QUEUE_READBACK_FAILED");
console.log(JSON.stringify({ status: "PASS", routes: config.routes.length, adapters: adapters.length, checkpoints: config.routes.length, queue: readback.state, idleGate: readback.claimPolicy, canary: "PASS", readback: "PASS" }));
