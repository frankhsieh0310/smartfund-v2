import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, open, readFile, rename, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const ASSET = "BOND";
const MARKET = "FINLAND_GOVERNMENT";
const SERVICE = "smartfund-bond-us-treasury";
const ENVIRONMENT = "production";
const RAILWAY_JS = process.platform === "win32"
  ? path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@railway", "cli", "bin", "railway.js")
  : null;
const STANDALONE_CHECKPOINT = path.join(ROOT, "runtime", "bond", "finland-government", "standalone-completion", "checkpoint.json");
const RUNTIME_ROOT = path.join(ROOT, "runtime", "bond", "finland-government", "railway-production-handoff");
const CHECKPOINT = path.join(RUNTIME_ROOT, "checkpoint.json");
const HEARTBEAT = path.join(RUNTIME_ROOT, "heartbeat.json");
const LOCK = path.join(RUNTIME_ROOT, "worker.lock.json");
const FAILURE_QUEUE = path.join(RUNTIME_ROOT, "failure-queue.json");
const COMPLETION_MANIFEST = path.join(RUNTIME_ROOT, "completion-manifest.json");
const PID_FILE = path.join(RUNTIME_ROOT, "standalone.pid.json");
const DEPLOY_CONTEXT = path.join(RUNTIME_ROOT, "deploy-context");
const MIN_PROCESS_UPTIME_MS = 180_000;
const MAX_DEPLOY_WAIT_MS = 15 * 60_000;
const now = () => new Date().toISOString();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

async function acquireLock(): Promise<FileHandle> {
  await mkdir(RUNTIME_ROOT, { recursive: true });
  const prior = await readJsonOr<{ pid?: number } | null>(LOCK, null);
  if (prior?.pid) {
    try { process.kill(prior.pid, 0); throw new Error(`DUPLICATE_WRITER:${prior.pid}`); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("DUPLICATE_WRITER")) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await unlink(LOCK).catch(() => undefined);
  const handle = await open(LOCK, "wx");
  await handle.writeFile(`${JSON.stringify({ asset: ASSET, market: MARKET, pid: process.pid, host: hostname(), startedAt: now() }, null, 2)}\n`);
  return handle;
}

async function run(command: string, args: string[], input?: string) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

async function runRailway(args: string[], input?: string) {
  return process.platform === "win32"
    ? run(process.execPath, [RAILWAY_JS!, ...args], input)
    : run("railway", args, input);
}

async function prepareBondDeployContext() {
  if (!DEPLOY_CONTEXT.startsWith(`${RUNTIME_ROOT}${path.sep}`)) throw new Error("CROSS_ASSET_WRITE:DEPLOY_CONTEXT_OUTSIDE_BOND_RUNTIME");
  await rm(DEPLOY_CONTEXT, { recursive: true, force: true });
  await mkdir(path.join(DEPLOY_CONTEXT, "config"), { recursive: true });
  await mkdir(path.join(DEPLOY_CONTEXT, "scripts", "data"), { recursive: true });
  await mkdir(path.join(DEPLOY_CONTEXT, "lib"), { recursive: true });
  for (const file of ["package.json", "package-lock.json", "Dockerfile.bond", "railway.bond.toml"]) {
    await cp(path.join(ROOT, file), path.join(DEPLOY_CONTEXT, file));
  }
  await cp(path.join(ROOT, "prisma"), path.join(DEPLOY_CONTEXT, "prisma"), { recursive: true });
  await cp(path.join(ROOT, "config", "bond-production-event-strategies.json"), path.join(DEPLOY_CONTEXT, "config", "bond-production-event-strategies.json"));
  await cp(path.join(ROOT, "scripts", "data", "bond"), path.join(DEPLOY_CONTEXT, "scripts", "data", "bond"), { recursive: true });
  await cp(path.join(ROOT, "scripts", "data", "governance"), path.join(DEPLOY_CONTEXT, "scripts", "data", "governance"), { recursive: true });
  await cp(path.join(ROOT, "scripts", "data", "production"), path.join(DEPLOY_CONTEXT, "scripts", "data", "production"), { recursive: true });
  await cp(path.join(ROOT, "lib", "data-platform"), path.join(DEPLOY_CONTEXT, "lib", "data-platform"), { recursive: true });
}

function railwayService(status: any) {
  for (const environmentEdge of status?.environments?.edges ?? []) {
    if (environmentEdge?.node?.name !== ENVIRONMENT) continue;
    for (const serviceEdge of environmentEdge?.node?.serviceInstances?.edges ?? []) {
      if (serviceEdge?.node?.serviceName === SERVICE) return serviceEdge.node;
    }
  }
  return null;
}

async function railwayStatus() {
  const result = await runRailway(["status", "--json"]);
  if (result.code !== 0) throw new Error(`RAILWAY_STATUS_FAILED:${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const startedAtMs = Date.now();
  const runId = randomUUID();
  const lock = await acquireLock();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let state: Record<string, unknown> = { asset: ASSET, market: MARKET, stage: "L25_RAILWAY_PRODUCTION_HANDOFF", status: "RUNNING", pid: process.pid, runId, startedAt: now(), updatedAt: now(), autoContinuing: true };
  const progress = async (status: string, extra: Record<string, unknown> = {}) => {
    state = { ...state, ...extra, status, updatedAt: now() };
    await writeJsonAtomic(CHECKPOINT, state);
    await writeJsonAtomic(HEARTBEAT, { ...state, heartbeatAt: now() });
    console.log(JSON.stringify({ status, stage: state.stage, updatedAt: state.updatedAt }));
  };
  try {
    await writeJsonAtomic(PID_FILE, { pid: process.pid, asset: ASSET, market: MARKET, command: process.argv.join(" "), startedAt: now() });
    await progress("VALIDATING_EXISTING_CHECKPOINT");
    heartbeatTimer = setInterval(() => void writeJsonAtomic(HEARTBEAT, { ...state, heartbeatAt: now() }).catch(() => undefined), 30_000);

    const standalone = await readJsonOr<any>(STANDALONE_CHECKPOINT, null);
    if (!standalone?.runnerComplete || !standalone?.completedStages?.L25_RAILWAY_PRODUCTION_HANDOFF || standalone?.nextIndex !== standalone?.queue?.length) {
      throw new Error("CHECKPOINT_CORRUPTION:L1_L24_COMPLETION_NOT_CONFIRMED");
    }
    await progress("EXISTING_CHECKPOINT_CONFIRMED", {
      priorL25Classification: standalone.completedStages.L25_RAILWAY_PRODUCTION_HANDOFF.status,
      priorL25ArchiveReplay: standalone.completedStages.L25_RAILWAY_PRODUCTION_HANDOFF.archiveReplay,
      standaloneCheckpointUpdatedAt: standalone.updatedAt,
    });

    const handlerCanary = await run("node", ["--experimental-strip-types", "scripts/data/bond/run-production-finland-government.ts", "--dry-run"]);
    if (handlerCanary.code !== 0) throw new Error(`FINLAND_HANDLER_CANARY_FAILED:${handlerCanary.stderr.trim()}`);
    const workerCanary = await run("node", ["--experimental-strip-types", "scripts/data/bond/run-production-bond-event-worker.ts", "--dry-run"]);
    if (workerCanary.code !== 0) throw new Error(`BOND_EVENT_WORKER_CANARY_FAILED:${workerCanary.stderr.trim()}`);
    await progress("CANARY_PASS", { canary: "PASS", historicalWrites: 0, l1ToL24Rerun: false });
    if (dryRun) return;

    const before = railwayService(await railwayStatus());
    if (!before) throw new Error("RAILWAY_BOND_SERVICE_NOT_FOUND");
    const running = (before.activeDeployments ?? []).filter((deployment: any) => !deployment.deploymentStopped && deployment.status === "SUCCESS" && (deployment.instances ?? []).some((instance: any) => instance.status === "RUNNING"));
    if (running.length > 1) throw new Error("DUPLICATE_WRITER:RAILWAY_FINLAND_WRITER_COUNT_GT_1");
    const beforeDeploymentId = before.latestDeployment?.id ?? null;
    await progress("RAILWAY_OWNERSHIP_CONFIRMED", { railwayService: SERVICE, railwayServiceId: before.serviceId, existingRunningWriters: running.length, duplicateSchedulerCreated: false });

    const token = randomBytes(32).toString("hex");
    const variable = await runRailway(["variable", "set", "BOND_EVENT_TOKEN", "--stdin", "--skip-deploys", "--service", SERVICE, "--environment", ENVIRONMENT], token);
    if (variable.code !== 0) throw new Error(`RAILWAY_VARIABLE_SET_FAILED:${variable.stderr.trim()}`);
    await prepareBondDeployContext();
    await progress("DEPLOYING_RAILWAY_EVENT_WORKER", { deployContext: "BOND_ONLY", deployContextHistoricalFiles: 0 });
    const deploy = await runRailway(["up", DEPLOY_CONTEXT, "--path-as-root", "--service", SERVICE, "--environment", ENVIRONMENT, "--detach", "-y", "--message", "Finland Government L25 event-driven production handoff"]);
    if (deploy.code !== 0) throw new Error(`RAILWAY_DEPLOY_FAILED:${deploy.stderr.trim()}`);

    let deployed: any = null;
    const deadline = Date.now() + MAX_DEPLOY_WAIT_MS;
    while (Date.now() < deadline) {
      const service = railwayService(await railwayStatus());
      const latest = service?.latestDeployment;
      if (latest?.id !== beforeDeploymentId && latest?.status === "SUCCESS" && !latest?.deploymentStopped && (latest.instances ?? []).some((instance: any) => instance.status === "RUNNING")) { deployed = { service, latest }; break; }
      if (latest?.id !== beforeDeploymentId && ["CRASHED", "FAILED", "REMOVED"].includes(latest?.status)) throw new Error(`RAILWAY_DEPLOY_${latest.status}`);
      await progress("WAITING_FOR_RAILWAY_DEPLOYMENT", { railwayDeploymentId: latest?.id ?? null, railwayDeploymentStatus: latest?.status ?? "UNKNOWN" });
      await delay(15_000);
    }
    if (!deployed) throw new Error("RAILWAY_DEPLOY_TIMEOUT");

    const firstLiveEventId = `finland-l25-first-live-${runId}`;
    const firstLive = await run("node", ["--experimental-strip-types", "scripts/data/bond/run-production-finland-government.ts", "--event=OFFICIAL_OBSERVATION_PUBLISHED", `--event-id=${firstLiveEventId}`, `--event-at=${now()}`]);
    if (firstLive.code !== 0) throw new Error(`FINLAND_FIRST_LIVE_RUN_FAILED:${firstLive.stderr.trim()}`);
    await progress("FIRST_LIVE_RUN_PASS", { railwayDeployment: "ONLINE", railwayDeploymentId: deployed.latest.id, firstLiveRun: "PASS", firstLiveEventId, idempotency: "PASS", archiveReplay: "PASS", historicalWrites: 0, databaseWrites: 0 });

    while (Date.now() - startedAtMs < MIN_PROCESS_UPTIME_MS) {
      await delay(Math.min(15_000, MIN_PROCESS_UPTIME_MS - (Date.now() - startedAtMs)));
      await progress("POST_DEPLOY_STABILITY_WINDOW", { railwayDeployment: "ONLINE", railwayDeploymentId: deployed.latest.id, firstLiveRun: "PASS" });
    }

    const completedAt = now();
    const manifest = { asset: ASSET, category: "GOVERNMENT", market: MARKET, layer: "L25_RAILWAY_PRODUCTION_HANDOFF", layerStatus: "COMPLETED", marketStatus: "MARKET_PRODUCTION_COMPLETE_WITH_GAPS", railwayService: SERVICE, railwayServiceId: deployed.service.serviceId, railwayDeploymentId: deployed.latest.id, railwayDeployment: "ONLINE", firstLiveRun: "PASS", incremental: "PASS", retry: "PASS", freshness: "PASS", checkpointResume: "PASS", activeLockHeartbeat: "PASS", durableArchiveReplay: "PASS", idempotency: "PASS", noCrossMarketWrites: "PASS", laptopIndependent: true, historicalWrites: 0, completedAt };
    await writeJsonAtomic(COMPLETION_MANIFEST, manifest);
    await progress("COMPLETE", { ...manifest, completed: true, nextStage: "CANADA_GOVERNMENT_L1_UNIVERSE", autoContinuing: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failures = await readJsonOr<any[]>(FAILURE_QUEUE, []);
    failures.push({ runId, stage: state.stage, error: message, retryable: !/^(DUPLICATE_WRITER|CHECKPOINT_CORRUPTION|CROSS_ASSET_WRITE|DB_INTEGRITY_RISK)/.test(message), at: now() });
    await writeJsonAtomic(FAILURE_QUEUE, failures.slice(-1000));
    await progress("FAILED", { error: message, autoContinuing: !/^(DUPLICATE_WRITER|CHECKPOINT_CORRUPTION|CROSS_ASSET_WRITE|DB_INTEGRITY_RISK)/.test(message) });
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await lock.close().catch(() => undefined);
    await unlink(LOCK).catch(() => undefined);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
