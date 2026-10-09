import { readFile } from "node:fs/promises";
import path from "node:path";

const proofPath = path.resolve("runtime", "global-stock", "explicit-idle-proof.json");
const queuePath = path.resolve("runtime", "stock-public-source-expansion", "background-queue.json");
type Proof = { state?: string; allExistingQueuesIdle?: boolean; noScheduledWorkDue?: boolean; expiresAt?: string };
async function read<T>(file: string): Promise<T | null> { try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return null; } }
const queue = await read<Record<string, unknown>>(queuePath);
if (!queue) throw new Error("EXPANSION_QUEUE_NOT_BOOTSTRAPPED");
const proof = await read<Proof>(proofPath);
const valid = proof?.state === "EXPLICIT_IDLE" && proof.allExistingQueuesIdle === true && proof.noScheduledWorkDue === true && typeof proof.expiresAt === "string" && Date.parse(proof.expiresAt) > Date.now();
if (!valid) {
  console.log(JSON.stringify({ state: "WAIT_BACKOFF", claimed: false, reason: "EXISTING_STOCK_IDLE_UNPROVEN", dbConnected: false, checkpointChanged: false, schedulerOwnsRetry: true }));
  process.exit(0);
}
console.log(JSON.stringify({ state: "IDLE_PROOF_ACCEPTED", claimed: false, reason: "ROUTE_EXECUTORS_OWN_BOUNDED_CLAIMS", dbConnected: false, checkpointChanged: false }));
