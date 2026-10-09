import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

const wait = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
let ownerPid = Number(process.env.GLOBAL_FUND_SUPERVISOR_PID ?? 0);
for (let attempt = 0; attempt < 30; attempt++) {
  if (!ownerPid) ownerPid = Number((await readFile(resolve("runtime/global-fund/moneydj-public-layer/pid"), "utf8").catch(() => "0")).trim());
  if (Number.isInteger(ownerPid) && ownerPid > 0) { try { process.kill(ownerPid, 0); break; } catch {} }
  ownerPid = 0; await wait(1_000);
}
if (!ownerPid) throw new Error("GLOBAL_FUND_SUPERVISOR_NOT_LIVE_AFTER_30S");

const runtimeDir = resolve("runtime/global-fund/nav-owned-child");
const lockPath = resolve(runtimeDir, "single-owner.lock");
const healthPath = resolve(runtimeDir, "health.json");
const cadenceMs = 6 * 60 * 60 * 1000;
let ownsLock = false;

async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function acquire() {
  await mkdir(runtimeDir, { recursive: true });
  try {
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    await handle.writeFile(JSON.stringify({ ownerPid, childPid: process.pid, acquiredAt: new Date().toISOString() }));
    await handle.close(); ownsLock = true;
  } catch {
    const lock = JSON.parse(await readFile(lockPath, "utf8").catch(() => "{}"));
    try { process.kill(Number(lock.childPid), 0); throw new Error(`NAV_CHILD_ALREADY_LIVE:${lock.childPid}`); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("NAV_CHILD_ALREADY_LIVE")) throw error;
      await rm(lockPath, { force: true });
      return acquire();
    }
  }
}

async function runOnce() {
  try { process.kill(ownerPid, 0); } catch { throw new Error(`GLOBAL_FUND_SUPERVISOR_NOT_LIVE:${ownerPid}`); }
  const startedAt = new Date().toISOString();
  await atomic(healthPath, { ownerType: "OWNED_CHILD_WORKER", ownerPid, childPid: process.pid, state: "RUNNING", heartbeat: startedAt, checkpoint: "runtime/global-fund/checkpoint.json" });
  const result = await new Promise<{ code: number; tail: string[] }>((complete) => {
    const tail: string[] = [];
    const child = spawn(process.execPath, ["--import", "tsx", "--env-file=.env", "scripts/data/global-fund/run-global-fund-latest.ts"], {
      cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, SMARTFUND_SCHEDULER: "1", SMARTFUND_SUPERVISOR_PID: String(ownerPid), SMARTFUND_NODE_ID: `global-fund-supervisor:${ownerPid}:nav-child` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => { tail.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean).map(line => line.slice(0, 1000))); if (tail.length > 8) tail.splice(0, tail.length - 8); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", error => complete({ code: 1, tail: [error.message] }));
    child.on("exit", code => complete({ code: code ?? 1, tail }));
  });
  const completedAt = new Date().toISOString(), nextRunAt = new Date(Date.now() + cadenceMs).toISOString();
  await atomic(healthPath, { ownerType: "OWNED_CHILD_WORKER", ownerPid, childPid: process.pid, state: result.code === 0 ? "SCHEDULED_WAIT" : "RETRY_WAIT", heartbeat: completedAt, lastSuccess: result.code === 0 ? completedAt : null, lastExitCode: result.code, nextRunAt, checkpoint: "runtime/global-fund/checkpoint.json", tail: result.tail, autoContinuing: true });
  return result.code;
}

await acquire();
try {
  while (true) {
    const code = await runOnce();
    await new Promise(resolveWait => setTimeout(resolveWait, code === 0 ? cadenceMs : 15 * 60 * 1000));
  }
} finally {
  if (ownsLock) await rm(lockPath, { force: true });
}
