import { readFile, rm } from "node:fs/promises";

const lockPath = "runtime/economic/event-engine/engine.lock";
const pidPath = "runtime/economic/event-engine/runner.pid";

const lockOwner = await readFile(lockPath, "utf8")
  .then((raw) => JSON.parse(raw) as { pid?: number })
  .catch(() => null);
const runnerPid = await readFile(pidPath, "utf8")
  .then((raw) => Number.parseInt(raw.trim(), 10))
  .catch(() => Number.NaN);
const ownerPid = Number.isInteger(lockOwner?.pid) ? lockOwner!.pid! : runnerPid;

let ownerAlive = false;
if (Number.isInteger(ownerPid) && ownerPid > 0) {
  try {
    process.kill(ownerPid, 0);
    ownerAlive = true;
  } catch {
    ownerAlive = false;
  }
}

if (!ownerAlive) await rm(lockPath, { force: true });

await import("./run-economic-event-engine-core.ts");
