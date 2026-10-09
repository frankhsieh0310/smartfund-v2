import assert from "node:assert/strict";
import { alertSeverity, evaluateAlertConditions, evaluateHealth } from "./health-evaluator.ts";
import { DATASETS } from "./dataset-registry.ts";
import { ADAPTER_KEYS } from "./coverage-adapters.ts";

const stock = DATASETS.find((item) => item.key === "STOCK_CURRENT_PRICE")!;
const futures = DATASETS.find((item) => item.key === "FUTURES_CONTRACT_HISTORY")!;
const baseRuntime = { state: "RUNNING", runtimeActive: true, heartbeatStale: false, nextRunOverdue: false, pending: 0, lastError: null };

assert.equal(evaluateHealth(stock, baseRuntime, { master: 100, target: 100, ever: 100, current: 10, promotionLagSeconds: null, rawAvailable: false }).state, "FALSE_HEALTHY");
assert.equal(evaluateHealth(stock, { ...baseRuntime, runtimeActive: false, heartbeatStale: true, pending: 5 }, { master: 100, target: 100, ever: 95, current: 90, promotionLagSeconds: null, rawAvailable: false }).state, "STOPPED_WITH_PENDING");
assert.equal(evaluateHealth(futures, baseRuntime, { master: 33, target: 5, ever: 5, current: 5, promotionLagSeconds: null, rawAvailable: false }).state, "STATIC_SCOPE_TOO_NARROW");
assert.equal(evaluateHealth(stock, baseRuntime, { master: 100, target: 100, ever: 100, current: 100, promotionLagSeconds: 1000, rawAvailable: true }).state, "HEALTHY");
assert.deepEqual(evaluateAlertConditions("DEGRADED", { master: 100, target: 100, ever: 90, current: 70, never: 10, promotionLagSeconds: null, rawAvailable: false }, { master: 100, target: 100, current: 90, never: 10 }), ["COVERAGE_DROP"]);
assert.deepEqual(evaluateAlertConditions("STATIC_SCOPE_TOO_NARROW", { master: 33, target: 5, ever: 5, current: 5, never: 28, promotionLagSeconds: null, rawAvailable: false }, null), ["STATIC_SCOPE_TOO_NARROW"]);
assert.deepEqual(evaluateAlertConditions("HEALTHY", { master: 101, target: 100, ever: 90, current: 90, never: 11, promotionLagSeconds: null, rawAvailable: false }, { master: 100, target: 100, current: 90, never: 10 }), ["NEW_ASSET_NOT_ENROLLED"]);
assert.equal(alertSeverity("FALSE_HEALTHY", 1), "HIGH");
assert.equal(ADAPTER_KEYS.size, 29);
assert.deepEqual([...ADAPTER_KEYS].filter((key) => !DATASETS.some((dataset) => dataset.key === key)), []);
console.log("health-evaluator tests passed");
