import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeAssetRuntimeStatus, type AssetRunState } from "./write-asset-runtime-status.ts";

type Json = Record<string, any>;

async function readJson(path: string): Promise<Json> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as Json;
}

async function optionalJson(path: string): Promise<Json> {
  return readJson(path).catch(() => ({}));
}

function processAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid as number, 0); return true; } catch { return false; }
}

function bondType(scope: string | null): string | null {
  if (!scope) return null;
  if (scope.includes("CORPORATE")) return "CORPORATE_BOND";
  if (scope.includes("GOVERNMENT") || scope === "US_TREASURY") return "GOVERNMENT_BOND";
  if (scope.includes("MUNICIPAL")) return "MUNICIPAL_BOND";
  if (scope.includes("SUPRANATIONAL")) return "SUPRANATIONAL_BOND";
  return scope;
}

export async function publishFixedIncomeRuntimeStatus(): Promise<void> {
  const [health, queue, depth, incremental, yieldHealth, yieldQuality, spread, derivatives, mortgage, sovereign, gapManifest, gapQueue] = await Promise.all([
    optionalJson("runtime/bond/desktop-supervisor/health.json"),
    optionalJson("runtime/bond/global-individual-bond-queue/checkpoint.json"),
    optionalJson("runtime/bond/professional-depth/checkpoint.json"),
    optionalJson("runtime/bond/incremental/checkpoint.json"),
    optionalJson("runtime/government-yield/health.json"),
    optionalJson("runtime/government-yield/products/quality.json"),
    optionalJson("runtime/credit-spread/checkpoint.json"),
    optionalJson("runtime/credit-derivatives/checkpoint.json"),
    optionalJson("runtime/mortgage-rates/status.json"),
    optionalJson("runtime/sovereign-debt-aggregates/status.json"),
    optionalJson("runtime/fixed-income/fixed-income-gap-manifest.json"),
    optionalJson("runtime/fixed-income/depth-gap-work-queue.json"),
  ]);

  const childAlive = health.desktopProcessAlive === true && processAlive(health.desktopPid);
  const supervisorAlive = processAlive(health.supervisorPid);
  const currentMarket = String(incremental.scope ?? health.currentScope ?? queue.key ?? "") || null;
  const incrementalReady = queue.key === "FIRST_PASS_COMPLETE" && depth.status === "COMPLETE";
  const currentLayer = incrementalReady ? "Incremental" : depth.status === "COMPLETE" ? "Latest" : "Bond Reference Data";
  const currentTask = incrementalReady ? "Incremental" : depth.status === "COMPLETE" ? "Latest" : "Identity";
  const processed = incrementalReady ? Number(incremental.completedCycles ?? 0) : Number(depth.processed ?? 0);
  const total = incrementalReady ? null : Number(depth.totalEligible ?? 0) || null;
  const coverage = total ? `${((processed / total) * 100).toFixed(1)}%` : `${Number(health.completedScopes ?? 0)}/64 markets; ${Number(health.verifiedBondLinks ?? 0)} verified links`;
  const blocker = health.status === "RETRY_WAITING" && health.lastExitCode ? `BOND_WORKER_EXIT_${health.lastExitCode}` : null;
  const nextRunAt = !childAlive && supervisorAlive && health.updatedAt && health.restartDelaySeconds
    ? new Date(Date.parse(health.updatedAt) + Number(health.restartDelaySeconds) * 1000).toISOString()
    : derivatives.nextRunAt ?? spread.nextRunAt ?? null;
  let runState: AssetRunState = childAlive ? "RUNNING" : blocker ? "BLOCKED" : nextRunAt ? "SCHEDULED_WAIT" : "UNEXPECTED_STOP";
  if (!supervisorAlive && !childAlive && queue.key === "FIRST_PASS_COMPLETE" && depth.status === "COMPLETE" && !nextRunAt) runState = "UNEXPECTED_STOP";

  const progressAt = incremental.updatedAt ?? health.lastCheckpoint ?? depth.updatedAt ?? null;
  const nextMarket = incremental.nextResumeScope ?? null;
  const lastProgress = incrementalReady
    ? `${currentMarket} Incremental: cycle ${processed}; checkpoint updated ${progressAt}; next ${nextMarket ?? "scheduler cycle"}`
    : `Bond Identity: ${Number(depth.processed ?? 0)} / ${Number(depth.totalEligible ?? 0)} processed; mapped ${Number(health.verifiedBondLinks ?? 0)}; coverage ${coverage}`;
  const quoteReady = Number(health.verifiedBondLinks ?? 0) > 0 && yieldHealth.status === "CURRENT" && Number(yieldQuality.series ?? 0) > 0 && spread.status === "IDLE";
  const currentGap = gapQueue.items?.find((item: Json) => item.state === "RUNNING") ?? gapQueue.items?.find((item: Json) => ["DELEGATED_EXISTING_WORKER","PENDING","RETRY_WAIT"].includes(item.state)) ?? null;
  const gapsCompleted = gapQueue.items?.filter((item: Json) => item.state === "COMPLETE").length ?? 0;

  await writeAssetRuntimeStatus("FIXED_INCOME", {
    CURRENT_PHASE: "PRODUCTION_MAINTENANCE",
    CURRENT_LAYER: currentLayer,
    CURRENT_TASK: currentTask,
    CURRENT_MARKET: currentMarket,
    CURRENT_BOND_TYPE: bondType(currentMarket),
    CURRENT_ISSUER: null,
    CURRENT_SOURCE: "EXISTING_FIXED_INCOME_WORKERS",
    PROCESSED: processed,
    TOTAL: total,
    COVERAGE: coverage,
    RUN_STATE: runState,
    PROCESS_ID: childAlive ? health.desktopPid : supervisorAlive ? health.supervisorPid : null,
    HEARTBEAT_AT: health.updatedAt ?? new Date().toISOString(),
    LAST_PROGRESS_AT: progressAt,
    LAST_PROGRESS: lastProgress,
    CHECKPOINT: currentMarket,
    BLOCKER: blocker,
    NEXT: nextMarket ? `Process ${nextMarket}` : "Run next scheduled incremental Fixed Income cycle",
    NEXT_RUN_AT: nextRunAt,
    LATEST_YIELD_STATUS: yieldHealth.status ?? "NOT_READY",
    CURVE_STATUS: Number(yieldQuality.series ?? 0) > 0 ? `PRODUCTION_${yieldQuality.series}_SERIES_${yieldQuality.observations}_ROWS` : "NOT_READY",
    SPREAD_STATUS: spread.status === "IDLE" ? `PRODUCTION_${spread.totalRows ?? 0}_ROWS` : spread.status ?? "NOT_READY",
    QUOTE_STATUS: quoteReady ? "READY" : "NOT_READY",
    CONTINUING: health.autoContinuing === false ? "NO" : "YES",
    DOMAIN_STATUS: {
      CREDIT_DERIVATIVES: derivatives.status ?? "NOT_READY",
      MORTGAGE_RATES: mortgage.status ?? "NOT_READY",
      SOVEREIGN: sovereign.scheduler === "ACTIVE" ? "CURRENT_AND_AUTO_UPDATING" : "NOT_READY",
    },
    DEPTH_AUDIT_STATUS: gapManifest.counts ? "COMPLETE_CONTINUING" : "NOT_READY",
    DEPTH_GAPS_TOTAL: gapManifest.counts?.total ?? null,
    DEPTH_GAPS_P0: gapManifest.counts?.P0 ?? null,
    DEPTH_GAPS_P1: gapManifest.counts?.P1 ?? null,
    DEPTH_GAPS_P2: gapManifest.counts?.P2 ?? null,
    DEPTH_GAPS_P3: gapManifest.counts?.P3 ?? null,
    DETERMINISTIC_GAPS_TOTAL: gapManifest.counts?.deterministic ?? null,
    BLOCKED_GAPS_TOTAL: gapManifest.counts?.blocked ?? null,
    CURRENT_GAP_ID: currentGap?.gap_id ?? null,
    CURRENT_GAP_DOMAIN: currentGap ? `${currentGap.domain}/${currentGap.subdomain}` : null,
    CURRENT_MARKET_GAP: currentGap?.market ?? null,
    CURRENT_BOND_TYPE_GAP: currentGap?.bond_type ?? null,
    GAPS_COMPLETED: gapsCompleted,
    LAST_GAP_PROGRESS: currentGap ? `${currentGap.gap_id} ${currentGap.state}; attempts=${currentGap.attempts}; checkpoint=${currentGap.checkpoint}` : `${gapsCompleted} deterministic gaps complete; no eligible gap running`,
    GAP_QUEUE_STATUS: gapQueue.status ?? "NOT_READY",
  });
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/publish-fixed-income-runtime-status.ts")) {
  publishFixedIncomeRuntimeStatus().catch((error) => { console.error(error); process.exitCode = 1; });
}
