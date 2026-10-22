export const AUTHORIZED_FAILURE_CLASSES = [
  "WORKER_DEAD_WITH_PENDING",
  "STALE_RUNTIME_OWNERSHIP",
  "OVERDUE_SCHEDULED_WAIT",
  "RETRY_QUEUE_STALLED",
  "TRANSIENT_NETWORK_EXIT",
  "TRANSIENT_DB_CONNECTION_FAILURE",
  "VERIFIED_DB_WRITE_PATH_FAILURE",
] as const;

export const FORBIDDEN_FAILURE_CLASSES = [
  "SOURCE_LIMITED", "LICENSE_CONSTRAINED", "NOT_CONFIGURED", "IDENTITY_BLOCKED",
  "STATIC_SCOPE_TOO_NARROW", "SCHEMA_MISSING", "MIGRATION_REQUIRED",
  "DESTRUCTIVE_MIGRATION_REQUIRED", "PROVIDER_TERMS_REQUIRED", "NEW_API_KEY_REQUIRED",
  "CREDENTIAL_REQUIRED", "LOW_CONFIDENCE_EVIDENCE", "AMBIGUOUS_OWNERSHIP",
  "UNKNOWN_ROOT_CAUSE", "CANONICAL_DATA_CORRUPTION",
] as const;

export type FailureClass = typeof AUTHORIZED_FAILURE_CLASSES[number];
export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export type CandidateEvidence = {
  condition: string;
  healthState: string;
  confidence: Confidence;
  pending: number;
  pidConfirmedDead: boolean;
  heartbeatStale: boolean;
  nextRunOverdue: boolean;
  checkpointExists: boolean;
  liveDuplicateOwner: boolean;
  actionContractKnown: boolean;
  transientFailure: boolean;
  retryCount: number;
  exactWritableAlternate: boolean;
  cooldownActive: boolean;
  attempts: number;
};

export type PolicyDecision = { eligible: boolean; failureClass: FailureClass | null; reasons: string[] };
const authorized = new Set<string>(AUTHORIZED_FAILURE_CLASSES);
const confidenceRank: Record<Confidence, number> = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export function evaluateRemediationCandidate(evidence: CandidateEvidence): PolicyDecision {
  const failureClass = authorized.has(evidence.condition) ? evidence.condition as FailureClass : null;
  const reasons: string[] = [];
  if (!failureClass) reasons.push("FAILURE_CLASS_NOT_AUTHORIZED");
  if (confidenceRank[evidence.confidence] < confidenceRank.MEDIUM) reasons.push("EVIDENCE_CONFIDENCE_BELOW_MEDIUM");
  if (!evidence.actionContractKnown) reasons.push("DATASET_ACTION_CONTRACT_NOT_CONFIGURED");
  if (evidence.liveDuplicateOwner) reasons.push("LIVE_DUPLICATE_OWNER_PRESENT");
  if (evidence.cooldownActive) reasons.push("REMEDIATION_COOLDOWN_ACTIVE");
  if (evidence.attempts >= 3) reasons.push("MAX_REMEDIATION_ATTEMPTS_REACHED");

  if (failureClass === "WORKER_DEAD_WITH_PENDING") {
    if (!evidence.pidConfirmedDead) reasons.push("PID_NOT_CONFIRMED_DEAD");
    if (evidence.pending <= 0) reasons.push("NO_PENDING_WORK");
    if (!evidence.checkpointExists) reasons.push("CHECKPOINT_NOT_CONFIRMED");
  } else if (failureClass === "STALE_RUNTIME_OWNERSHIP") {
    if (!evidence.pidConfirmedDead || !evidence.heartbeatStale) reasons.push("STALE_DEAD_OWNER_NOT_CONFIRMED");
    if (!evidence.checkpointExists) reasons.push("CHECKPOINT_NOT_CONFIRMED");
  } else if (failureClass === "OVERDUE_SCHEDULED_WAIT") {
    if (!evidence.nextRunOverdue || !evidence.pidConfirmedDead || evidence.pending <= 0) reasons.push("OVERDUE_INACTIVE_PENDING_GATE_FAILED");
    if (!evidence.checkpointExists) reasons.push("CHECKPOINT_NOT_CONFIRMED");
  } else if (failureClass === "RETRY_QUEUE_STALLED") {
    if (evidence.pending <= 0 || !evidence.transientFailure || evidence.retryCount >= 3) reasons.push("BOUNDED_TRANSIENT_RETRY_GATE_FAILED");
    if (!evidence.checkpointExists) reasons.push("CHECKPOINT_NOT_CONFIRMED");
  } else if (failureClass === "TRANSIENT_NETWORK_EXIT") {
    if (!evidence.pidConfirmedDead || !evidence.transientFailure || !evidence.checkpointExists) reasons.push("TRANSIENT_EXIT_GATE_FAILED");
  } else if (failureClass === "TRANSIENT_DB_CONNECTION_FAILURE") {
    if (!evidence.pidConfirmedDead || !evidence.transientFailure || !evidence.checkpointExists) reasons.push("TRANSIENT_DB_EXIT_GATE_FAILED");
  } else if (failureClass === "VERIFIED_DB_WRITE_PATH_FAILURE") {
    if (!evidence.pidConfirmedDead || !evidence.exactWritableAlternate || !evidence.checkpointExists) reasons.push("VERIFIED_WRITE_PATH_GATE_FAILED");
  }
  return { eligible: reasons.length === 0, failureClass, reasons: [...new Set(reasons)] };
}

export function isTransientError(value: unknown): boolean {
  return /timeout|timed out|temporary network|can't reach database server|econnreset|econnrefused|emaxconnsession|max clients reached|http\s*429|\b429\b|http\s*5\d\d|\b50[0234]\b/i.test(String(value ?? ""));
}
