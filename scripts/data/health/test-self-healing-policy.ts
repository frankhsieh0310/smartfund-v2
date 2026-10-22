import assert from "node:assert/strict";
import { evaluateRemediationCandidate, type CandidateEvidence } from "./self-healing-policy.ts";

const valid: CandidateEvidence = { condition: "WORKER_DEAD_WITH_PENDING", healthState: "STOPPED_WITH_PENDING", confidence: "HIGH", pending: 4, pidConfirmedDead: true, heartbeatStale: true, nextRunOverdue: false, checkpointExists: true, liveDuplicateOwner: false, actionContractKnown: true, transientFailure: false, retryCount: 0, exactWritableAlternate: false, cooldownActive: false, attempts: 0 };
assert.equal(evaluateRemediationCandidate(valid).eligible, true); // dead PID + pending + checkpoint
assert.equal(evaluateRemediationCandidate({ ...valid, condition: "STALE_RUNTIME_OWNERSHIP" }).eligible, true);
assert.equal(evaluateRemediationCandidate({ ...valid, condition: "SOURCE_LIMITED" }).eligible, false);
assert.equal(evaluateRemediationCandidate({ ...valid, condition: "SCHEMA_MISSING" }).eligible, false);
assert.equal(evaluateRemediationCandidate({ ...valid, confidence: "LOW" }).eligible, false);
assert.equal(evaluateRemediationCandidate({ ...valid, condition: "TRANSIENT_NETWORK_EXIT", transientFailure: true }).eligible, true);
assert.equal(evaluateRemediationCandidate({ ...valid, liveDuplicateOwner: true }).eligible, false);
assert.equal(evaluateRemediationCandidate({ ...valid, attempts: 3 }).eligible, false);
console.log("self-healing policy tests passed");
