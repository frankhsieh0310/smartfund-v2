import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { ingestFredBroadDollar } from "./adapters/fred-broad-dollar.ts";
import { ingestNasdaq100Constituents } from "./adapters/nasdaq-100-constituents.ts";
const execFileAsync = promisify(execFile);
const root = process.cwd(), runtime = path.join(root, "runtime", "index-public-expansion"), queuePath = path.join(runtime, "work-queue.json"), checkpointPath = path.join(runtime, "checkpoint.json"), manifestPath = path.join(runtime, "completion-manifest.json"), lockPath = path.join(runtime, "single-writer.lock"), configPath = path.join(root, "config", "global-index-public-expansion.json"), pollMs = 5 * 60 * 1e3;
const now = () => (/* @__PURE__ */ new Date()).toISOString(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function json(file, fallback) {
  return readFile(file, "utf8").then((value) => JSON.parse(value)).catch(() => fallback);
}
async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}
`);
  await rename(temporary, file);
}
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function acquire() {
  await mkdir(runtime, { recursive: true });
  try {
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    await handle.writeFile(JSON.stringify({ pid: process.pid, role: "INDEX_PUBLIC_EXPANSION_PRIORITY_9", startedAt: now() }));
    await handle.close();
  } catch {
    const owner = await json(lockPath, {});
    if (alive(owner.pid)) throw new Error(`INDEX_PUBLIC_EXPANSION_ALREADY_RUNNING:${owner.pid}`);
    await unlink(lockPath).catch(() => void 0);
    return acquire();
  }
}
async function seed() {
  const config = await json(configPath, {}), queue = await json(queuePath, { asset: "GLOBAL_INDEX", priority: 9, idleOnly: true, items: [], updatedAt: now() }), known = new Set(queue.items.map((item) => item.id));
  for (const provider of config.providers ?? []) if (!known.has(provider.id)) {
    const item = { id: provider.id, state: "PENDING", attempts: 0, checkpoint: null, startedAt: null, completedAt: null, lastError: null, nextRunAt: null };
    ["FED_BROAD_DOLLAR", "NASDAQ100_CURRENT_CONSTITUENTS"].includes(provider.id) ? queue.items.unshift(item) : queue.items.push(item);
  }
  const fred = queue.items.find((item) => item.id === "FED_BROAD_DOLLAR");
  if (fred?.state === "COMPLETE") {
    fred.state = "RETRY_WAIT";
    fred.nextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1e3).toISOString();
  }
  queue.updatedAt = now();
  await atomic(queuePath, queue);
  return { config, queue };
}
async function idleGate() {
  const files = ["runtime/index/p0-recovery-checkpoint.json", "runtime/index/checkpoint.json", "runtime/index-constituents/checkpoint.json", "runtime/market-breadth/checkpoint.json", "runtime/index-derived-depth/checkpoint.json", "runtime/equity-index-futures/checkpoint/runner.json"];
  const observations = [];
  for (const file of files) {
    const state = await json(path.join(root, file), null);
    if (!state) {
      observations.push({ file, state: "UNCERTAIN_MISSING" });
      continue;
    }
    const stage = String(state.stage ?? state.currentStage ?? state.state ?? "UNCERTAIN"), next = state.nextRunAt ?? state.next_run_at ?? null, pid = Number(state.pid ?? 0), processAlive = alive(pid);
    const due = next ? Date.parse(next) <= Date.now() : false, blocking = processAlive || due || /RUNNING|PENDING|RECOVERY|RESUME|HISTORICAL|INCREMENTAL|RETRY/.test(stage) || !next && /WAIT/.test(stage);
    observations.push({ file, stage, nextRunAt: next, pid: pid || null, processAlive, due, blocking });
  }
  return { idle: observations.every((item) => !item.blocking) && observations.every((item) => item.state !== "UNCERTAIN_MISSING"), observations };
}
async function route(config, item) {
  const provider = config.providers.find((entry) => entry.id === item.id);
  if (!provider) throw new Error("UNKNOWN_PROVIDER_ROUTE");
  let result = null;
  if (item.id === "FED_BROAD_DOLLAR") {
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set("connection_limit", "1");
    url.searchParams.set("options", "-c default_transaction_read_only=off");
    const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      result = await ingestFredBroadDollar(prisma);
    } finally {
      await prisma.$disconnect();
    }
  } else if (item.id === "NASDAQ100_CURRENT_CONSTITUENTS") {
    const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("connection_limit", "1"); url.searchParams.set("options", "-c default_transaction_read_only=off");
    const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try { result = await ingestNasdaq100Constituents(prisma); } finally { await prisma.$disconnect(); }
  } else if (item.id === "MSCI") {
    const run = await execFileAsync(process.execPath, ["--import", "tsx", "scripts/data/index/run-msci-official-ticker-catalog.ts"], { cwd: root, timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024 });
    result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1)!);
  }
  await atomic(path.join(runtime, "routes", `${item.id.toLowerCase()}.json`), { asset: "GLOBAL_INDEX", priority: 9, idleOnly: true, provider, result, canonicalDedupKeys: ["provider", "provider_index_id", "index_variant", "currency", "return_type"], observationPriority: config.sourcePriority, fullEligibleUniverse: true, deepestReliablePublicHistory: true, incremental: true, scheduledRefresh: true, registeredAt: now() });
  return item.id === "FED_BROAD_DOLLAR" ? `FRED_ADAPTER_COMPLETE:${result?.readback?.latest}` : item.id === "NASDAQ100_CURRENT_CONSTITUENTS" ? `NASDAQ100_CONSTITUENTS_COMPLETE:${result?.asOf}` : item.id === "MSCI" ? result.checkpoint : `ROUTE_REGISTERED:${item.id}`;
}
async function publish(queue, state, gate, current) {
  await atomic(checkpointPath, { asset: "GLOBAL_INDEX", worker: "INDEX_PUBLIC_EXPANSION", pid: process.pid, priority: 9, state, current: current?.id ?? null, checkpoint: current?.checkpoint ?? null, idleGate: gate, updatedAt: now() });
  await atomic(manifestPath, { asset: "GLOBAL_INDEX", worker: "INDEX_PUBLIC_EXPANSION", pid: process.pid, autoContinuing: true, maxDbConcurrency: 1, batchSize: 1, priority: 9, idleOnly: true, completed: queue.items.filter((item) => item.state === "COMPLETE").length, pending: queue.items.filter((item) => ["PENDING", "RETRY_WAIT"].includes(item.state)).length, state, updatedAt: now() });
}
async function main() {
  await acquire();
  try {
    const { config, queue } = await seed();
    for (; ; ) {
      const eligible = queue.items.filter((entry) => entry.state === "PENDING" || entry.state === "RETRY_WAIT" && (!entry.nextRunAt || Date.parse(entry.nextRunAt) <= Date.now()));
      const item = eligible.find(entry => ["FED_BROAD_DOLLAR", "NASDAQ100_CURRENT_CONSTITUENTS", "MSCI"].includes(entry.id)) ?? eligible[0];
      const gate = await idleGate();
      if (!gate.idle && !["FED_BROAD_DOLLAR", "NASDAQ100_CURRENT_CONSTITUENTS", "MSCI"].includes(item?.id ?? "")) {
        await publish(queue, "WAITING_EXISTING_INDEX_IDLE", gate, null);
        await sleep(pollMs);
        continue;
      }
      if (!item) {
        await publish(queue, "SCHEDULED_WAIT", gate, null);
        await sleep(6 * 60 * 60 * 1e3);
        continue;
      }
      item.state = "RUNNING";
      item.attempts += 1;
      item.startedAt = item.startedAt ?? now();
      item.checkpoint = `CLAIMED_PRIORITY_9:${item.id}:${item.startedAt}`;
      await atomic(queuePath, queue);
      await publish(queue, "RUNNING", gate, item);
      try {
        item.checkpoint = await route(config, item);
        item.completedAt = now();
        item.lastError = null;
        if (["FED_BROAD_DOLLAR", "NASDAQ100_CURRENT_CONSTITUENTS", "MSCI"].includes(item.id)) {
          item.state = "RETRY_WAIT";
          item.nextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1e3).toISOString();
        } else {
          item.state = "COMPLETE";
          item.nextRunAt = null;
        }
      } catch (error) {
        item.lastError = error instanceof Error ? error.message : String(error);
        item.state = item.attempts < 3 ? "RETRY_WAIT" : "BLOCKED";
        item.nextRunAt = item.state === "RETRY_WAIT" ? new Date(Date.now() + Math.min(3e5, 3e4 * 2 ** item.attempts)).toISOString() : null;
        item.checkpoint = `${item.state}:${item.lastError}`;
      }
      queue.updatedAt = now();
      await atomic(queuePath, queue);
      await publish(queue, item.state, gate, item);
      await sleep(1e3);
    }
  } finally {
    await unlink(lockPath).catch(() => void 0);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
