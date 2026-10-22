import { spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

type AssetConfig = { asset: string; checkpoint: string; heartbeat: string; pidFile: string; command: string[] };
type Config = { version: number; ownerNodeId: string; pollIntervalMs: number; staggerMs: number; maxDbConcurrency: number; dbPoolMode: string; priorityPolicy: { ordinary: number; backgroundExpansion: number; uncertainIdle: string }; remoteAssets: string[]; assets: AssetConfig[] };
type AssetState = { asset: string; state: string; pid: number | null; checkpoint: string; heartbeatAt: string | null; priority: number; backgroundExpansion: string; reason?: string };

const root = process.cwd();
const runtime = path.join(root, "runtime", "ordinary-master-scheduler");
const lockPath = path.join(runtime, "master.lock");
const pidPath = path.join(runtime, "master.pid");
const healthPath = path.join(runtime, "health.json");
const config = JSON.parse(await readFile(path.join(root, "config", "ordinary-master-scheduler.json"), "utf8")) as Config;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const absolute = (file: string) => path.resolve(root, file);
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const atomic = async (file: string, value: unknown) => { const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, file); };
const json = async (file: string) => readFile(file, "utf8").then(JSON.parse).catch(() => null);
const readPid = async (file: string) => { const raw = await readFile(file, "utf8").catch(() => ""); const direct = Number(raw.trim()); if (direct) return direct; try { const value = JSON.parse(raw); return Number(value.pid ?? value.PROCESS_ID ?? value.supervisorPid) || null; } catch { return null; } };
const heartbeatTime = (value: any) => value?.HEARTBEAT_AT ?? value?.heartbeatAt ?? value?.lastHeartbeat ?? value?.updatedAt ?? value?.LAST_PROGRESS_AT ?? null;
const runState = (value: any) => value?.RUN_STATE ?? value?.status ?? value?.STATUS ?? value?.state ?? null;

async function databasePreflight() {
  if (!process.env.DATABASE_URL?.includes(":6543")) throw new Error("DB_POOL_POLICY_MISMATCH");
  const prisma = new PrismaClient();
  try { await prisma.$queryRawUnsafe("SELECT 1"); } finally { await prisma.$disconnect(); }
}

async function acquire() {
  await mkdir(runtime, { recursive: true });
  try { const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY); await handle.writeFile(JSON.stringify({ pid: process.pid, owner: config.ownerNodeId, startedAt: new Date().toISOString() })); await handle.close(); }
  catch { const owner = await json(lockPath); if (alive(Number(owner?.pid) || null)) throw new Error(`ORDINARY_MASTER_ALREADY_RUNNING:${owner.pid}`); await rm(lockPath, { force: true }); return acquire(); }
  await writeFile(pidPath, `${process.pid}\n`);
}

async function inspect(asset: AssetConfig): Promise<AssetState> {
  const checkpointPresent = asset.checkpoint.startsWith("DATABASE:") || await stat(absolute(asset.checkpoint)).then(() => true).catch(() => false);
  if (!checkpointPresent) return { asset: asset.asset, state: "WAITING_DEPENDENCY", pid: null, checkpoint: asset.checkpoint, heartbeatAt: null, priority: 0, backgroundExpansion: "WAITING_RECOVERY", reason: "CHECKPOINT_NOT_VERIFIED" };
  const heartbeat = await json(absolute(asset.heartbeat));
  const pid = await readPid(absolute(asset.pidFile));
  const heartbeatAt = heartbeatTime(heartbeat);
  const state = runState(heartbeat);
  const fresh = heartbeatAt ? Date.now() - Date.parse(heartbeatAt) < 20 * 60_000 : false;
  if (alive(pid) && fresh) return { asset: asset.asset, state: state ?? "RUNNING", pid, checkpoint: asset.checkpoint, heartbeatAt, priority: 0, backgroundExpansion: "IDLE_ONLY" };
  if (alive(pid) && !fresh) return { asset: asset.asset, state: "WAITING_DEPENDENCY", pid, checkpoint: asset.checkpoint, heartbeatAt, priority: 0, backgroundExpansion: "IDLE_ONLY", reason: "LIVE_PID_STALE_HEARTBEAT_UNCERTAIN" };
  return { asset: asset.asset, state: "SCHEDULED", pid: null, checkpoint: asset.checkpoint, heartbeatAt, priority: 0, backgroundExpansion: "IDLE_ONLY" };
}

async function launch(asset: AssetConfig) {
  const [file, ...args] = asset.command;
  const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  childEnvironment.Path = [path.dirname(process.execPath), `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`, `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0`, process.env.Path ?? process.env.PATH ?? ""].join(";");
  const assetLogDirectory = path.join(runtime, "assets");
  await mkdir(assetLogDirectory, { recursive: true });
  const stdout = openSync(path.join(assetLogDirectory, `${asset.asset.toLowerCase()}.stdout.log`), "a");
  const stderr = openSync(path.join(assetLogDirectory, `${asset.asset.toLowerCase()}.stderr.log`), "a");
  const child = spawn(file, args, { cwd: root, detached: false, stdio: ["ignore", stdout, stderr], windowsHide: true, env: { ...childEnvironment, MAX_DB_CONCURRENCY: "1", SMARTFUND_NODE_ID: config.ownerNodeId } });
  closeSync(stdout);
  closeSync(stderr);
  if (asset.pidFile.includes("master-launched.pid")) { await mkdir(path.dirname(absolute(asset.pidFile)), { recursive: true }); await writeFile(absolute(asset.pidFile), `${child.pid}\n`); }
  return child.pid ?? null;
}

async function cycle() {
  const states: AssetState[] = [];
  const inspected = await Promise.all(config.assets.map(inspect));
  const activeDbOwner = inspected.find(item => item.pid && alive(item.pid));
  let launched: string | null = null;
  for (let index = 0; index < config.assets.length; index += 1) {
    const asset = config.assets[index];
    const current = inspected[index];
    if (!activeDbOwner && !launched && current.state === "SCHEDULED") {
      const pid = await launch(asset);
      launched = asset.asset;
      states.push({ ...current, state: "RUNNING", pid, reason: "RESUMED_EXISTING_ENTRYPOINT" });
      await sleep(config.staggerMs);
    } else if (current.state === "SCHEDULED" && (activeDbOwner || launched)) states.push({ ...current, state: "WAITING_RESOURCE", reason: activeDbOwner ? `SERIALIZED_BEHIND_${activeDbOwner.asset}` : `SERIALIZED_AFTER_${launched}` });
    else states.push(current);
  }
  states.push({ asset: "MACRO", state: "REMOTE_OWNED", pid: null, checkpoint: "REMOTE", heartbeatAt: null, priority: 0, backgroundExpansion: "REMOTE_OWNED" });
  await atomic(healthPath, { masterPid: process.pid, owner: config.ownerNodeId, state: "RUNNING", dbPoolMode: config.dbPoolMode, maxDbConcurrency: config.maxDbConcurrency, priorityPolicy: config.priorityPolicy, launchedThisCycle: launched, assets: states, updatedAt: new Date().toISOString() });
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
await acquire();
try { await databasePreflight(); while (!stopping) { await cycle(); await sleep(config.pollIntervalMs); } }
finally { await rm(lockPath, { force: true }); await rm(pidPath, { force: true }); }
