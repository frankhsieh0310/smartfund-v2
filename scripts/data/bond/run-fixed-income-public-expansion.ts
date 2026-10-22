import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const runtimeRoot = path.join(root, "runtime", "fixed-income", "public-expansion");
const queueFile = path.join(runtimeRoot, "queue.json");
const statusFile = path.join(runtimeRoot, "status.json");
const lockFile = path.join(runtimeRoot, "worker.lock");
const supervisorLockFile = path.join(runtimeRoot, "supervisor.lock");
const heartbeatFile = path.join(runtimeRoot, "heartbeat.json");
const desktopWorker = process.argv.includes("--desktop-worker");
const fixedIncomeStatusFile = path.join(root, "runtime-status", "fixed-income.json");
const registryFile = path.join(root, "config", "fixed-income-public-expansion-registry.json");
const now = () => new Date().toISOString();

async function json<T>(file: string, fallback: T): Promise<T> {
  return readFile(file, "utf8").then((value) => JSON.parse(value) as T).catch(() => fallback);
}
async function atomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function runOnce(): Promise<void> {
  await mkdir(runtimeRoot, { recursive: true });
  let lock;
  try { lock = await open(lockFile, "wx"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    const fixed = await json<Record<string, unknown>>(fixedIncomeStatusFile, {});
    const definitelyIdle = fixed.RUN_STATE === "COMPLETE" && fixed.CONTINUING !== "YES";
    const queue = await json<Record<string, unknown> & { items?: Array<Record<string,unknown>> }>(queueFile, { items: [] });
    const registry = await json<{routes?:Array<{id:string;state:string}>}>(registryFile,{});
    const dispositions=new Map((registry.routes??[]).map(route=>[route.id,route.state]));
    for(const item of queue.items??[]){const state=dispositions.get(String(item.id));if(state)item.state=state;}
    if (!definitelyIdle) {
      const status = {
        state: "WAITING_EXISTING_FIXED_INCOME",
        reason: "IDLE_NOT_EXPLICITLY_CONFIRMED",
        existingRunState: fixed.RUN_STATE ?? "UNKNOWN",
        existingContinuing: fixed.CONTINUING ?? "UNKNOWN",
        claimed: false,
        processId: process.pid,
        nextEligibleAt: fixed.NEXT_RUN_AT ?? null,
        maxDbConcurrency: 1,
        updatedAt: now()
      };
      queue.status = status.state; queue.updatedAt = status.updatedAt;
      await atomic(queueFile, queue); await atomic(statusFile, status);
      console.log(JSON.stringify(status)); return;
    }
    const status = {
      state: "IDLE_CONFIRMED_ROUTE_HANDOFF_READY",
      reason: "SOURCE_SPECIFIC_ORDINARY_ADAPTERS_MAY_CLAIM_IN_PRIORITY_ORDER",
      claimed: false,
      processId: process.pid,
      maxDbConcurrency: 1,
      updatedAt: now()
    };
    queue.status = status.state; queue.updatedAt = status.updatedAt;
    await atomic(queueFile, queue); await atomic(statusFile, status);
    console.log(JSON.stringify(status));
  } finally {
    await lock.close(); await rm(lockFile, { force: true });
  }
}

async function main(): Promise<void> {
  if (!desktopWorker) return runOnce();
  await mkdir(runtimeRoot, { recursive: true });
  let owner;
  try { owner = await open(supervisorLockFile, "wx"); await owner.writeFile(JSON.stringify({ pid:process.pid, startedAt:now(), owner:"FIXED_INCOME_PUBLIC_EXPANSION" })); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
  const release=async()=>{await owner.close().catch(()=>undefined);await rm(supervisorLockFile,{force:true}).catch(()=>undefined);};
  process.once("SIGTERM",()=>{void release().finally(()=>process.exit(0));});
  process.once("SIGINT",()=>{void release().finally(()=>process.exit(0));});
  try {
    for (;;) {
      await runOnce();
      const status=await json<Record<string,unknown>>(statusFile,{});
      const candidate=Date.parse(String(status.nextEligibleAt??""));
      const nextRunAt=new Date(Number.isFinite(candidate)&&candidate>Date.now()?candidate:Date.now()+900_000).toISOString();
      await atomic(heartbeatFile,{asset:"FIXED_INCOME_PUBLIC_EXPANSION",pid:process.pid,state:status.state??"SCHEDULED_WAIT",targetMetric:"queue executable/terminal disposition",targetValue:{executable:0,complete:2,sourceLimited:6,licenseLimited:2},nextRunAt,updatedAt:now(),autoContinuing:true});
      await new Promise(resolve=>setTimeout(resolve,Math.max(60_000,Date.parse(nextRunAt)-Date.now())));
    }
  } finally { await release(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
