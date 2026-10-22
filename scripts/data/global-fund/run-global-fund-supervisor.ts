import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeAssetRuntimeStatus } from "../runtime-status/write-asset-runtime-status.ts";
import { consumeNextFundGap } from "./consume-fund-depth-gap.ts";

type DomainName = "verifiedProvider" | "holdings" | "documents" | "feesTerms" | "classification" | "riskPerformance" | "styleDrift" | "moneydjDisclosure" | "lifecycleManager";
type Domain = {
  name: DomainName;
  runnerPath: string;
  checkpoint: string;
  queue: string;
  intervalMs: number;
  schedulerEnv?: string;
};

const startedAt = new Date().toISOString();
const runtimeDir = resolve("runtime/global-fund/supervisor");
const healthPath = resolve(runtimeDir, "health.json");
const allDomains: Domain[] = [
  { name: "verifiedProvider", runnerPath: "scripts/data/global-fund/run-provider-expansion-queue.ts", checkpoint: "runtime/global-fund/provider-expansion/company-queue.json", queue: "runtime/global-fund/provider-expansion/company-queue.json", intervalMs: 86_400_000 },
  { name: "holdings", runnerPath: "scripts/data/global-fund/run-fund-holdings-latest.ts", checkpoint: "runtime/global-fund/holdings/checkpoint.json", queue: "runtime/global-fund/holdings/queue.json", intervalMs: 86_400_000, schedulerEnv: "FUND_HOLDINGS_SCHEDULER" },
  { name: "documents", runnerPath: "scripts/data/global-fund/run-fund-documents-latest.ts", checkpoint: "runtime/global-fund/documents/checkpoint.json", queue: "runtime/global-fund/documents/queue.json", intervalMs: 604_800_000, schedulerEnv: "FUND_DOCUMENTS_SCHEDULER" },
  { name: "feesTerms", runnerPath: "scripts/data/global-fund/run-fund-fees-terms-latest.ts", checkpoint: "runtime/global-fund/fees-terms/checkpoint.json", queue: "runtime/global-fund/fees-terms/queue.json", intervalMs: 2_592_000_000, schedulerEnv: "FUND_FEES_TERMS_SCHEDULER" },
  { name: "classification", runnerPath: "scripts/data/global-fund/run-fund-classification-latest.ts", checkpoint: "runtime/global-fund/classification/checkpoint.json", queue: "runtime/global-fund/classification/queue.json", intervalMs: 2_592_000_000, schedulerEnv: "FUND_CLASSIFICATION_SCHEDULER" },
  { name: "riskPerformance", runnerPath: "scripts/data/global-fund/run-fund-risk-performance-latest.ts", checkpoint: "runtime/global-fund/risk-performance/checkpoint.json", queue: "runtime/global-fund/risk-performance/queue.json", intervalMs: 86_400_000, schedulerEnv: "FUND_RISK_PERFORMANCE_SCHEDULER" },
  { name: "styleDrift", runnerPath: "scripts/data/global-fund/run-fund-style-drift.ts", checkpoint: "runtime/global-fund/style-drift/checkpoint.json", queue: "runtime/global-fund/style-drift/queue.json", intervalMs: 86_400_000, schedulerEnv: "FUND_STYLE_DRIFT_SCHEDULER" },
  { name: "moneydjDisclosure", runnerPath: "scripts/data/global-fund/run-fund-moneydj-disclosure.ts", checkpoint: "runtime/global-fund/moneydj-disclosure/checkpoint.json", queue: "runtime/global-fund/moneydj-disclosure/queue.json", intervalMs: 86_400_000, schedulerEnv: "FUND_MONEYDJ_DISCLOSURE_SCHEDULER" },
  { name: "lifecycleManager", runnerPath: "scripts/data/global-fund/run-fund-lifecycle-manager.ts", checkpoint: "runtime/global-fund/lifecycle-manager/checkpoint.json", queue: "runtime/global-fund/lifecycle-manager/queue.json", intervalMs: 86_400_000, schedulerEnv: "FUND_LIFECYCLE_MANAGER_SCHEDULER" },
];
const requestedDomain = process.argv.find((value) => value.startsWith("--domain="))?.slice(9) as DomainName | undefined;
const domains = requestedDomain ? allDomains.filter((domain) => domain.name === requestedDomain) : allDomains;
if (requestedDomain && domains.length === 0) throw new Error(`UNKNOWN_FUND_DOMAIN:${requestedDomain}`);
const domainLockPath = requestedDomain ? resolve(`runtime/global-fund/${requestedDomain === "riskPerformance" ? "risk-performance" : requestedDomain}/single-writer.lock`) : null;

const state: Record<DomainName, any> = Object.fromEntries(domains.map((domain) => [domain.name, {
  runnerPath: domain.runnerPath, lastRun: null, lastExitCode: null, checkpoint: domain.checkpoint,
  nextEligibleAt: new Date().toISOString(), latestPath: true, incremental: true, scheduler: true,
  status: "RESUME_PENDING", logTail: [],
}])) as Record<DomainName, any>;

async function readJson(path: string) {
  try { return JSON.parse(await readFile(resolve(path), "utf8")); } catch { return null; }
}

async function atomicHealth() {
  await mkdir(runtimeDir, { recursive: true });
  const temporary = `${healthPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    pid: process.pid, supervisorPid: process.pid, processAlive: true, supervisorAlive: true, startedAt, lastHeartbeat: new Date().toISOString(),
    state: domains.some((domain) => state[domain.name].status === "RUNNING") ? "RUNNING" : "SCHEDULED_WAIT",
    nextRun: domains.map((domain) => state[domain.name].nextEligibleAt).sort()[0] ?? null,
    processed: requestedDomain === "riskPerformance" ? Number(state.riskPerformance?.processedFunds ?? 0) : null,
    lastTargetProgress: requestedDomain === "riskPerformance" ? state.riskPerformance?.lastSuccessfulRunPreserved ?? null : null,
    boundedConcurrency: 1, doubleWriter: false, singleWriterAllDomains: true, domains: state,
  }, null, 2)}\n`, "utf8");
  await rename(temporary, healthPath);
}

async function runDomain(domain: Domain) {
  const current = state[domain.name];
  current.status = "RUNNING";
  current.lastRun = new Date().toISOString();
  await atomicHealth();
  const lines: string[] = [];
  const exitCode = await new Promise<number>((complete) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--env-file=.env", domain.runnerPath], {
      cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, ...(domain.schedulerEnv ? { [domain.schedulerEnv]: "1" } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    current.childPid = child.pid ?? null;
    void writeAssetRuntimeStatus("FUND", {
      CURRENT_PHASE: "CONTINUOUS_DEPTH_BACKFILL", CURRENT_LAYER: domain.name === "verifiedProvider" ? "P0A" : domain.name === "holdings" || domain.name === "documents" ? "P1" : "P0B",
      CURRENT_TASK: ({ verifiedProvider: "Fund Identity", holdings: "Holdings", documents: "Documents", feesTerms: "Fees", classification: "Benchmark", riskPerformance: "Risk", styleDrift: "Style Drift", moneydjDisclosure: "PIT Holdings", lifecycleManager: "Manager History" } as const)[domain.name],
      CURRENT_SOURCE: null, RUN_STATE: "RUNNING", PROCESS_ID: child.pid ?? process.pid, HEARTBEAT_AT: new Date().toISOString(),
      CHECKPOINT: domain.checkpoint, BLOCKER: null, NEXT: domain.name, NEXT_RUN_AT: null, CONTINUING: "YES",
    });
    const collect = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/).filter(Boolean)) lines.push(line.slice(0, 1000));
      if (lines.length > 12) lines.splice(0, lines.length - 12);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => { lines.push(error.message); complete(1); });
    child.on("exit", (code) => complete(code ?? 1));
  });
  const checkpoint = await readJson(domain.checkpoint);
  current.lastExitCode = exitCode;
  current.logTail = lines;
  current.nextEligibleAt = checkpoint?.nextEligibleAt ?? new Date(Date.now() + domain.intervalMs).toISOString();
  current.status = exitCode === 0 ? (checkpoint?.status ?? "HEALTHY_WAITING") : "FAILED_ISOLATED";
  current.processedFunds = checkpoint?.processedFunds ?? null;
  current.lastSuccessfulRunPreserved = checkpoint?.lastSuccessfulRun ?? current.lastSuccessfulRunPreserved ?? null;
  current.childPid = null;
  await writeAssetRuntimeStatus("FUND", {
    CURRENT_PHASE: "CONTINUOUS_DEPTH_BACKFILL", CURRENT_LAYER: "SCHEDULER", CURRENT_TASK: "Scheduler",
    PROCESSED: checkpoint?.processedFunds ?? checkpoint?.completed ?? checkpoint?.lastProcessedHolding ?? 0,
    RUN_STATE: exitCode === 0 ? "SCHEDULED_WAIT" : "BLOCKED", PROCESS_ID: process.pid,
    HEARTBEAT_AT: new Date().toISOString(), LAST_PROGRESS_AT: checkpoint?.lastSuccessfulRun ?? current.lastRun,
    LAST_PROGRESS: exitCode === 0 ? `${domain.name} checkpoint completed` : `${domain.name} exited with code ${exitCode}`,
    CHECKPOINT: domain.checkpoint, BLOCKER: exitCode === 0 ? null : `DOMAIN_EXIT_${exitCode}`,
    NEXT: "BACKGROUND_CONTINUE", NEXT_RUN_AT: current.nextEligibleAt, CONTINUING: "YES",
  });
  await atomicHealth();
}

async function main() {
  let lease: Awaited<ReturnType<typeof open>> | null = null;
  if (domainLockPath) {
    await mkdir(resolve(domainLockPath, ".."), { recursive: true });
    try { lease = await open(domainLockPath, "wx"); }
    catch {
      const stale = await readJson(domainLockPath);
      let running = false;
      if (stale?.pid) { try { process.kill(stale.pid, 0); running = true; } catch { running = false; } }
      if (running) throw new Error(`FUND_DOMAIN_ALREADY_RUNNING:${requestedDomain}:${stale.pid}`);
      await rm(domainLockPath, { force: true });
      lease = await open(domainLockPath, "wx");
    }
    await lease.writeFile(JSON.stringify({ pid: process.pid, domain: requestedDomain, startedAt }));
  }
  try {
  if (process.argv.includes("--gap-once")) { console.log(JSON.stringify(await consumeNextFundGap())); return; }
  for (const domain of domains) {
    const checkpoint = await readJson(domain.checkpoint);
    if (checkpoint?.lastSuccessfulRun) state[domain.name].lastSuccessfulRunPreserved = checkpoint.lastSuccessfulRun;
  }
  await atomicHealth();
  for (const domain of domains) await runDomain(domain);
  await consumeNextFundGap();
  while (true) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 15_000));
    for (const domain of domains) {
      if (Date.parse(state[domain.name].nextEligibleAt) <= Date.now()) await runDomain(domain);
    }
    if (domains.every((domain) => state[domain.name].status !== "RUNNING")) await consumeNextFundGap();
    await atomicHealth();
  }
  } finally {
    await lease?.close();
    if (domainLockPath) await rm(domainLockPath, { force: true });
  }
}

process.on("SIGTERM", async () => { await atomicHealth(); process.exit(0); });
main().catch(async (error) => {
  state.verifiedProvider.status = `SUPERVISOR_ERROR:${error instanceof Error ? error.message : String(error)}`;
  await atomicHealth();
  process.exit(1);
});
