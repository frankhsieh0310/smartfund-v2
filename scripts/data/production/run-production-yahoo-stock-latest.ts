import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { acquireLifecycleLock, heartbeatLifecycleLock, releaseLifecycleLock } from "./run-lifecycle.ts";

// Dedicated single-purpose Railway entrypoint for Global Stock latest auto-sync only.
// Deliberately does not import or duplicate the dispatcher/calendar/checkpoint/writer logic —
// it only starts the existing engine and exits, so Railway's cronSchedule (not an internal
// loop) is what makes this recurring. See railway.toml for the invocation cadence.
//
// Railway's cron allows invocations to overlap in time (a new container starts on every tick
// regardless of whether the previous one finished), and a single dispatcher pass can legitimately
// run far longer than 5 minutes (observed: tens of minutes to several hours for a market with a
// large retry backlog). Without a lease, that means multiple independent dispatcher processes
// could run concurrently. This lease makes "one active dispatcher at a time" an invariant at the
// Railway-invocation layer, reusing the same production_scheduler_locks table (and 10-minute
// stale-expiry convention) the per-market jobs already use — not a second locking framework.
// maxConcurrentMarketJobs (which bounds markets running *inside* one dispatcher call) is untouched.
const LEASE_JOB_ID = "global-stock-dispatcher-lease";
const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

const prisma = new PrismaClient();
const owner = `${process.env.RAILWAY_DEPLOYMENT_ID ?? process.env.HOSTNAME ?? "worker"}:${process.pid}:${randomUUID()}`;

function run(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with ${code ?? "signal"}`))));
  });
}

async function main(): Promise<void> {
  const acquired = await acquireLifecycleLock(prisma, LEASE_JOB_ID, owner);
  if (!acquired) {
    console.log(JSON.stringify({ at: new Date().toISOString(), status: "NOOP", reason: "GLOBAL_STOCK_DISPATCHER_LEASE_HELD_BY_ANOTHER_INVOCATION" }));
    return;
  }
  const heartbeat = setInterval(() => {
    heartbeatLifecycleLock(prisma, LEASE_JOB_ID, owner).catch((error: unknown) => console.error("LEASE_HEARTBEAT_FAILED", error));
  }, HEARTBEAT_INTERVAL_MS);
  try {
    await run("scripts/data/daily/run-production-yahoo-daily.ts", []);
  } finally {
    clearInterval(heartbeat);
    await releaseLifecycleLock(prisma, LEASE_JOB_ID, owner);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
