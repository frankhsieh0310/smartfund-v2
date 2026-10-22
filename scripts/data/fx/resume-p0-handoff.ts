import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const runtime = resolve("runtime", "fx", "p0-handoff");
const checkpointPath = resolve(runtime, "checkpoint.json");
const heartbeatPath = resolve(runtime, "heartbeat.json");
const lockPath = resolve(runtime, "single-writer.lock");
const worker = resolve("scripts", "data", "fx", "run-p0-handoff.ts");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
function alive(pid: unknown) { try { process.kill(Number(pid), 0); return Number(pid) > 0; } catch { return false; } }
async function json(path: string) { return JSON.parse(await readFile(path, "utf8")); }

const before = await stat(checkpointPath);
const lock = await json(lockPath).catch(() => null);
if (lock && alive(lock.pid)) throw new Error(`ACTIVE_FX_P0_WRITER:${lock.pid}`);
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (databaseUrl.port !== "6543") throw new Error("FX_P0_REQUIRES_TRANSACTION_POOLING_6543");
databaseUrl.searchParams.set("pgbouncer", "true");
databaseUrl.searchParams.set("connection_limit", "1");
const child = spawn(process.execPath, ["--env-file=.env", worker, "--background"], {
  cwd: resolve("."), detached: true, windowsHide: true, stdio: "ignore",
  env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
});
child.unref();
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  await sleep(2_000);
  const heartbeat = await json(heartbeatPath).catch(() => null);
  const after = await stat(checkpointPath).catch(() => null);
  if (child.exitCode !== null) throw new Error(`FX_P0_RESUME_EXIT_${child.exitCode}`);
  if (heartbeat && alive(heartbeat.pid) && after && after.mtimeMs > before.mtimeMs) {
    console.log(JSON.stringify({ status: "PASS", pid: heartbeat.pid, checkpoint: heartbeat.current, updatedAt: heartbeat.updatedAt }));
    process.exit(0);
  }
}
throw new Error("FX_P0_RESUME_VERIFICATION_TIMEOUT");
