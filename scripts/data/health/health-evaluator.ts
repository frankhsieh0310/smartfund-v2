import type { DatasetDefinition } from "./dataset-registry.ts";

export type RuntimeEvidence = { state: string; runtimeActive: boolean; heartbeatStale: boolean; nextRunOverdue: boolean; futureRunScheduled?: boolean; pending: number; lastError?: string | null };
export type CoverageEvidence = { master: number | null; target: number | null; ever: number | null; current: number | null; promotionLagSeconds: number | null; rawAvailable: boolean; adapterStatus?: "COMPLETE" | "PARTIAL" | "BLOCKED" };
export type PreviousCoverage = { master: number | null; target: number | null; current: number | null; never: number | null };

export function evaluateHealth(definition: DatasetDefinition, runtime: RuntimeEvidence, coverage: CoverageEvidence) {
  const reasons: string[] = [];
  const currentPercent = coverage.target && coverage.current !== null ? coverage.current / coverage.target : null;
  if (!definition.isEnabled) return { state: "NOT_CONFIGURED", reasons: ["DATASET_DISABLED"] };
  if (coverage.adapterStatus === "BLOCKED") return { state: "NOT_CONFIGURED", reasons: ["AUTHORITATIVE_CANONICAL_RELATION_NOT_AVAILABLE"] };
  if (coverage.adapterStatus === "PARTIAL" && coverage.current === null) return { state: "DEGRADED", reasons: ["ADAPTER_PARTIAL_CURRENT_COUNT_NOT_AVAILABLE"] };
  if (coverage.rawAvailable && coverage.promotionLagSeconds !== null && coverage.promotionLagSeconds > (definition.graceSeconds ?? 0)) return { state: "CANONICAL_PROMOTION_LAG", reasons: ["RAW_NEWER_THAN_CANONICAL_BEYOND_GRACE"] };
  if (["STATIC_CONFIG", "CANARY", "PROVIDER_COHORT"].includes(definition.targetMode) && coverage.master !== null && coverage.target !== null && coverage.master > coverage.target) return { state: "STATIC_SCOPE_TOO_NARROW", reasons: ["MASTER_EXCEEDS_CONFIGURED_TARGET"] };
  if (definition.auto === "NO" && coverage.master !== null && coverage.ever !== null && coverage.master > coverage.ever) return { state: "NEW_ASSETS_NOT_AUTO_ENROLLED", reasons: ["MASTER_ASSETS_OUTSIDE_SUCCESS_COHORT"] };
  if (runtime.pending > 0 && ((!runtime.runtimeActive && !runtime.futureRunScheduled) || runtime.heartbeatStale || runtime.nextRunOverdue)) return { state: "STOPPED_WITH_PENDING", reasons: ["PENDING_WITHOUT_LIVE_RUNTIME_OR_VALID_FUTURE_RUN"] };
  if (runtime.lastError?.includes("read-only transaction")) return { state: "SOURCE_LIMITED", reasons: ["WORKER_WRITE_BLOCKED_BY_READ_ONLY_TRANSACTION"] };
  if (runtime.runtimeActive && currentPercent !== null && currentPercent < 0.5) return { state: "FALSE_HEALTHY", reasons: ["RUNTIME_ACTIVE_CANONICAL_COVERAGE_LOW"] };
  if (coverage.master === null && coverage.ever === null) return { state: "UNKNOWN", reasons: ["DATASET_LEVEL_COVERAGE_ADAPTER_NOT_AVAILABLE"] };
  if (coverage.current === 0 && coverage.target !== null && coverage.target > 0) return { state: "STALE", reasons: ["NO_CURRENT_CANONICAL_ENTITY"] };
  if (currentPercent !== null && currentPercent < 0.99) return { state: "DEGRADED", reasons: ["CURRENT_COVERAGE_BELOW_99_PERCENT"] };
  if (runtime.state === "RETRY_WAIT" || runtime.nextRunOverdue) return { state: "RETRY_WAIT", reasons: ["RUNTIME_WAITING_FOR_RETRY"] };
  if (runtime.lastError) reasons.push("RUNTIME_ERROR_PRESENT");
  return { state: reasons.length ? "DEGRADED" : "HEALTHY", reasons };
}

const HEALTH_ALERTS: Record<string, string> = {
  STALE: "DATASET_STALE",
  STOPPED_WITH_PENDING: "WORKER_DEAD_WITH_PENDING",
  FALSE_HEALTHY: "FALSE_HEALTHY",
  CANONICAL_PROMOTION_LAG: "CANONICAL_PROMOTION_LAG",
  NEW_ASSETS_NOT_AUTO_ENROLLED: "NEW_ASSET_NOT_ENROLLED",
  STATIC_SCOPE_TOO_NARROW: "STATIC_SCOPE_TOO_NARROW",
};

export function evaluateAlertConditions(healthState: string, coverage: CoverageEvidence & { never?: number | null }, previous: PreviousCoverage | null): string[] {
  const conditions = new Set<string>();
  const healthCondition = HEALTH_ALERTS[healthState];
  if (healthCondition) conditions.add(healthCondition);
  if (previous && previous.current !== null && coverage.current !== null && previous.target && coverage.target) {
    const absoluteDrop = previous.current - coverage.current;
    const percentDrop = (previous.current / previous.target) - (coverage.current / coverage.target);
    if (absoluteDrop >= Math.max(5, Math.ceil(previous.current * 0.1)) && percentDrop >= 0.05) conditions.add("COVERAGE_DROP");
  }
  if (previous && previous.master !== null && coverage.master !== null && coverage.master > previous.master && previous.never !== null && coverage.never !== null && coverage.never > previous.never && (coverage.target ?? 0) <= (previous.target ?? 0)) {
    conditions.add("NEW_ASSET_NOT_ENROLLED");
  }
  return [...conditions].sort();
}

export function alertSeverity(condition: string, priority: number): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  if (condition === "DATASET_STALE" && priority <= 1) return "CRITICAL";
  if (["WORKER_DEAD_WITH_PENDING", "FALSE_HEALTHY", "CANONICAL_PROMOTION_LAG"].includes(condition)) return "HIGH";
  if (["COVERAGE_DROP", "RETRY_EXHAUSTED", "NEW_ASSET_NOT_ENROLLED"].includes(condition)) return "MEDIUM";
  return "LOW";
}
