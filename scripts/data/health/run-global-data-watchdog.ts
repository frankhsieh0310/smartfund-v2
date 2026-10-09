import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

type Row = Record<string, unknown>;
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const statusFile = resolve("runtime-status", "global-data-watchdog.json");
const intervalArg = process.argv.find((value) => value.startsWith("--interval-ms="));
const cyclesArg = process.argv.find((value) => value.startsWith("--cycles="));
const durationArg = process.argv.find((value) => value.startsWith("--duration-hours="));
const intervalMs = Math.max(1_000, Number(intervalArg?.slice(14) ?? 1_800_000));
const requestedCycles = process.argv.includes("--daemon") ? Number.POSITIVE_INFINITY : Math.max(1, Number(cyclesArg?.slice(9) ?? 1));
const durationHours = durationArg ? Math.max(1, Number(durationArg.slice(17))) : null;
const soakEndsAt = durationHours ? new Date(Date.now() + durationHours * 3_600_000) : null;
let cycleCount = 0;
let lastSuccess: string | null = null;
let lastError: string | null = null;
let stopping = false;
const invocationId = randomUUID();

function iso(date = new Date()): string { return date.toISOString(); }
function json(value: unknown): string { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2); }
async function atomicStatus(patch: Row): Promise<void> {
  const prior = await readFile(statusFile, "utf8").then((value) => JSON.parse(value) as Row).catch(() => ({}));
  const status = { ...prior, WATCHDOG_PID: process.pid, INVOCATION_ID: invocationId, STATE: "RUNNING", HEARTBEAT_AT: iso(), LAST_CYCLE_AT: prior.LAST_CYCLE_AT ?? null, LAST_SUCCESS_AT: lastSuccess, NEXT_RUN_AT: null, LAST_ERROR: lastError, CYCLE_COUNT: cycleCount, CADENCE_MS: intervalMs, TARGET_SOAK_HOURS: durationHours, SOAK_TARGET_END_AT: soakEndsAt?.toISOString() ?? null, AUTO_RESTART_ENABLED: false, SELF_HEALING_ENABLED: false, ...patch };
  await mkdir(dirname(statusFile), { recursive: true });
  const temporary = `${statusFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${json(status)}\n`, "utf8");
  await rename(temporary, statusFile);
}
async function waitWithHeartbeat(nextRunAt: string): Promise<void> {
  while (!stopping) {
    const remaining = Date.parse(nextRunAt) - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(60_000, remaining)));
    if (!stopping) await atomicStatus({ STATE: "SCHEDULED_WAIT", NEXT_RUN_AT: nextRunAt });
  }
}
async function snapshot(): Promise<Row> {
  const counts = (await prisma.$queryRawUnsafe<Row[]>(`SELECT (SELECT count(*) FROM dataset_registry)::bigint registered,(SELECT count(*) FROM dataset_alert_events)::bigint alerts,(SELECT count(*) FROM dataset_alert_events WHERE status='OPEN')::bigint open_alerts,(SELECT count(*) FROM dataset_alert_events WHERE status='RESOLVED')::bigint resolved_alerts`))[0];
  const health = await prisma.$queryRawUnsafe<Row[]>(`SELECT health_state,count(*)::bigint count FROM dataset_health_states GROUP BY health_state ORDER BY health_state`);
  const failed = (await prisma.$queryRawUnsafe<Row[]>(`SELECT count(*)::bigint count FROM dataset_health_states WHERE reason_codes ? 'EVALUATION_FAILED'`))[0];
  return { ...counts, health, failedToEvaluate: failed.count };
}
async function runRefresh(): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/data/health/refresh-global-data-health.ts"], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", stdout = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("health refresh exceeded 120 seconds"));
    }, 120_000);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-16_384); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolvePromise() : rejectPromise(new Error(stderr.trim() || stdout.trim() || `health refresh exited ${code ?? "signal"}`));
    });
  });
}
async function main(): Promise<void> {
  const before = await snapshot();
  await atomicStatus({ STATE: "RUNNING", STARTED_AT: iso(), SOAK_STARTED_AT: iso(), BASELINE: before });
  while (!stopping && cycleCount < requestedCycles && (!soakEndsAt || Date.now() < soakEndsAt.getTime())) {
    const cycleStartedAt = iso();
    const cycleStartedMs = Date.now();
    await atomicStatus({ STATE: "RUNNING", HEARTBEAT_AT: cycleStartedAt, LAST_ERROR: lastError });
    try {
      await runRefresh();
      cycleCount += 1;
      lastSuccess = iso();
      lastError = null;
    } catch (error) {
      cycleCount += 1;
      lastError = error instanceof Error ? error.message : String(error);
    }
    const after = await snapshot();
    const cycleDurationMs = Date.now() - cycleStartedMs;
    const more = !stopping && cycleCount < requestedCycles && (!soakEndsAt || Date.now() + intervalMs < soakEndsAt.getTime());
    const nextRunAt = more ? new Date(Date.now() + intervalMs).toISOString() : null;
    await atomicStatus({ STATE: more ? "SCHEDULED_WAIT" : (lastError ? "DEGRADED" : "COMPLETE"), HEARTBEAT_AT: iso(), LAST_CYCLE_AT: cycleStartedAt, LAST_CYCLE_DURATION_MS: cycleDurationMs, LAST_SUCCESS_AT: lastSuccess, NEXT_RUN_AT: nextRunAt, LAST_ERROR: lastError, CYCLE_COUNT: cycleCount, DATASETS_EVALUATED: Number(after.registered ?? 0), EVALUATION_FAILURES: Number(after.failedToEvaluate ?? 0), LAST_READBACK: after });
    if (!more) break;
    await waitWithHeartbeat(nextRunAt!);
  }
  if (stopping) await atomicStatus({ STATE: "STOPPED", NEXT_RUN_AT: null, STOPPED_AT: iso() });
  const finalStatus = JSON.parse(await readFile(statusFile, "utf8")) as Row;
  console.log(json({ watchdog: finalStatus, before, after: await snapshot() }));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopping = true; });

main().catch(async (error) => { lastError = error instanceof Error ? error.message : String(error); await atomicStatus({ STATE: "DEGRADED", LAST_ERROR: lastError }).catch(() => undefined); console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
