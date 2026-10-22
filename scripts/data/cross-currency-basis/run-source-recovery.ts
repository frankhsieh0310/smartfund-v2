import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sourceRegistry from "../../../config/cross-currency-basis-source-registry.json" with { type: "json" };

const runtimeRoot = resolve("runtime/cross-currency-basis");
const launchPairs = ["EUR/USD", "USD/JPY", "GBP/USD"];
const targetTenors = ["SOURCE_SUPPORTED_ONLY"];

async function main() {
  const checkedAt = new Date().toISOString();
  const selected = sourceRegistry.sources.find((source) => source.id === sourceRegistry.selectedPath);
  if (!selected) throw new Error("SELECTED_SOURCE_PATH_NOT_REGISTERED");

  const coverage = launchPairs.map((pair) => ({
    pair,
    availableTenors: pair === "EUR/USD" ? ["3M_IMM_NEARBY"] : [],
    missingTenors: [],
    sourceBlockedTenors: pair === "EUR/USD" ? ["3M_IMM_NEARBY"] : ["SOURCE_DISCOVERY_REQUIRED"],
    identityReady: false,
    directSourceAvailable: pair === "EUR/USD",
    licenseStatus: pair === "EUR/USD" ? "LICENSE_AND_ENTITLEMENT_REQUIRED" : "SOURCE_DISCOVERY_REQUIRED",
    currentReady: false,
    historyReady: false,
    historyCount: 0,
    firstDate: null,
    latestDate: null,
    benchmarkLegsReady: pair === "EUR/USD",
    quoteConventionReady: pair === "EUR/USD",
    provenanceReady: false,
    freshnessStatus: pair === "EUR/USD" ? "LICENSE_BLOCKED" : "SOURCE_PENDING",
    analyticsReady: false,
    missingReasons: pair === "EUR/USD"
      ? ["CME_OAUTH_ENTITLEMENT_MISSING", "CME_LICENSE_NOT_CONFIRMED", "NO_CANONICAL_RELATION"]
      : ["NO_VERIFIED_DIRECT_SOURCE", "BENCHMARK_CONVENTION_UNKNOWN", "NO_CANONICAL_RELATION"],
  }));

  const status = {
    task: "CROSS_CURRENCY_BASIS_P0_PROFESSIONAL_DEPTH_RECOVERY_V1",
    asset: "CROSS_CURRENCY_BASIS",
    checkedAt,
    recoveryStateBefore: "SOURCE_RECOVERY_PENDING",
    targetLaunchPairs: launchPairs,
    targetTenors,
    selectedSourcePath: selected.id,
    selectedSourceClassification: selected.classification,
    licenseStatus: "LICENSE_AND_ENTITLEMENT_REQUIRED",
    directBasisObservation: "NO",
    syntheticCanonicalQuotesCreated: "NO",
    canonicalIdentityBefore: "0/3",
    canonicalIdentityAfterCanary: "0/3",
    currentCoverageBefore: "0/3",
    currentCoverageAfterCanary: "0/3",
    historyCoverageBefore: "0/3",
    historyCoverageAfterCanary: "0/3",
    canonicalRelation: null,
    migrationPerformed: "NO",
    migrationState: "BLOCKED_UNTIL_LICENSED_SOURCE_CANARY_IS_FETCHABLE",
    writeCanary: "NO",
    readBack: "NO",
    latestPath: "BLOCKED_BY_LICENSE",
    incremental: "BLOCKED_BY_LICENSE",
    scheduler: "INACTIVE",
    autoContinuing: "NO",
    singleWriter: "YES",
    doubleWriter: "NO",
    backgroundQueueSize: 0,
    p0ProductionPathReady: "NO",
    depthGate: "FAIL",
    dataDepthLevel: "LEVEL_1_CONTRACT_ONLY",
    dataCoverageLevel: "LEVEL_0",
    professionalResearchLevel: "LEVEL_0",
    status: "SOURCE_RECOVERY_PENDING",
    blocker: "CME XEURBI is verified for EUR/USD but requires licensed OAuth entitlement; no verified direct USD/JPY or GBP/USD path is configured.",
    coverage,
  };
  const checkpoint = {
    asset: "CROSS_CURRENCY_BASIS",
    selectedSourcePath: selected.id,
    lastSourceState: "VERIFIED_SOURCE_AUTH_AND_LICENSE_BLOCKED",
    lastCanonicalDate: null,
    lastProcessedRecord: null,
    lastSuccessfulRun: null,
    lastDiscoveryCheck: checkedAt,
    nextEligibleAt: null,
    resumeConditions: ["CME_LICENSE_CONFIRMED", "CME_OAUTH_CLIENT_ENTITLED", "USDJPY_DIRECT_SOURCE_VERIFIED", "GBPUSD_DIRECT_SOURCE_VERIFIED"],
  };
  const blockedWorkItem = {
    id: "CROSS_CURRENCY_BASIS:CME_XEURBI_API:LICENSE_AND_AUTH",
    asset: "CROSS_CURRENCY_BASIS",
    sourceId: selected.id,
    state: "BLOCKED",
    reason: "LICENSE_AND_AUTH_REQUIRED",
    activeRetry: false,
    attempts: 0,
    nextEligibleAt: null,
    unblockRequirements: ["Document permitted use", "Provision entitled OAuth API client", "Verify one bounded EUR/USD response against methodology"],
    updatedAt: checkedAt,
  };

  await mkdir(runtimeRoot, { recursive: true });
  await Promise.all([
    writeFile(resolve(runtimeRoot, "status.json"), `${JSON.stringify(status, null, 2)}\n`),
    writeFile(resolve(runtimeRoot, "source-candidates.json"), `${JSON.stringify({ checkedAt, selectedPath: selected.id, sources: sourceRegistry.sources }, null, 2)}\n`),
    writeFile(resolve(runtimeRoot, "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`),
    writeFile(resolve(runtimeRoot, "coverage-matrix.json"), `${JSON.stringify({ checkedAt, coverage }, null, 2)}\n`),
    writeFile(resolve(runtimeRoot, "blocked-work-item.json"), `${JSON.stringify(blockedWorkItem, null, 2)}\n`),
    writeFile(resolve(runtimeRoot, "writer-ownership.json"), `${JSON.stringify({ asset: "CROSS_CURRENCY_BASIS", owner: null, supervisorPid: null, supervisorAlive: false, singleWriter: true, doubleWriter: false, checkedAt }, null, 2)}\n`),
  ]);
  console.log(JSON.stringify(status, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
