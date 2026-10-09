import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { evaluateRemediationCandidate, isTransientError, type CandidateEvidence, type Confidence } from "./self-healing-policy.ts";
import { actionContractMetadata, loadActionContracts } from "./action-contracts.ts";
import { readDatabaseOwnership } from "./database-checkpoint-adapter.ts";

type Row = Record<string, any>;
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const runtimePath = resolve("runtime-status", process.argv.includes("--daemon") ? "global-data-self-healing.json" : "global-data-self-healing-dry-run.json");
const auditPath = resolve("runtime-status", "global-data-self-healing-audit.jsonl");
const live = process.argv.includes("--live");
const daemon = process.argv.includes("--daemon");
const intervalMs = 1_800_000;
const invocationId = randomUUID();
let cycleCount = 0;
let stopping = false;

function now() { return new Date().toISOString(); }
function pidAlive(pid: unknown): boolean { const value = Number(pid); if (!value) return false; try { process.kill(value, 0); return true; } catch { return false; } }
async function exists(path: string | undefined): Promise<boolean> { if (!path) return false; return stat(resolve(path)).then(() => true).catch(() => false); }
async function fileMark(path: string | undefined): Promise<number | null> { if (!path || path.startsWith("DATABASE:")) return null; return stat(resolve(path)).then((value) => value.mtimeMs).catch(() => null); }
async function atomic(value: Row): Promise<void> { await mkdir(dirname(runtimePath), { recursive: true }); const temporary = `${runtimePath}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, runtimePath); }
async function audit(value: Row): Promise<void> { await mkdir(dirname(auditPath), { recursive: true }); await appendFile(auditPath, `${JSON.stringify({ timestamp: now(), invocationId, ...value })}\n`); }
async function priorRuntime(): Promise<Row> { return readFile(runtimePath, "utf8").then((value) => JSON.parse(value)).catch(() => ({})); }

async function executeContract(contract: Row): Promise<Row> {
  const command = contract.resume_command?.command;
  const args = contract.resume_command?.args;
  if (command !== "node" || !Array.isArray(args) || args.some((value: unknown) => String(value).includes("<"))) throw new Error("EXACT_ACTION_COMMAND_NOT_EXECUTABLE");
  const beforeFile = await fileMark(contract.checkpoint_path);
  const beforeDatabase = await readDatabaseOwnership(prisma, contract.checkpoint_path);
  const startedAt = now();
  const child = spawn(process.execPath, args, { cwd: resolve(contract.working_directory ?? "."), env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_192); });
  const timeoutMs = Math.min(30 * 60_000, Math.max(1_000, Number(contract.verification_timeout_seconds ?? 900) * 1_000));
  const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => { child.kill(); rejectPromise(new Error("BOUNDED_ACTION_TIMEOUT")); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolvePromise(0) : rejectPromise(new Error(stderr || `ACTION_EXIT_${code}`)); });
  });
  const afterFile = await fileMark(contract.checkpoint_path);
  const afterDatabase = await readDatabaseOwnership(prisma, contract.checkpoint_path);
  const fileForward = beforeFile !== null && afterFile !== null && afterFile > beforeFile;
  const databaseForward = beforeDatabase.supported && afterDatabase.supported && ((afterDatabase.heartbeatAt?.valueOf() ?? 0) > (beforeDatabase.heartbeatAt?.valueOf() ?? 0) || afterDatabase.pending < beforeDatabase.pending);
  if (!fileForward && !databaseForward) throw new Error("POST_ACTION_CHECKPOINT_DID_NOT_ADVANCE");
  return { startedAt, completedAt: now(), pidAfter: child.pid, exitCode, checkpointPreserved: true, processVerification: "PASS", dataVerification: "CHECKPOINT_FORWARD", fileForward, databaseForward };
}

async function cycle(): Promise<Row> {
  const startedAt = now();
  const configuredContracts = await loadActionContracts();
  const contractMetadata = await actionContractMetadata();
  const actionContracts = Object.fromEntries(configuredContracts.filter((item) => item.enabled).map((item) => [item.registry_dataset_key ?? item.dataset_key, item]));
  const rows = await prisma.$queryRawUnsafe<Row[]>(`
    SELECT a.id incident_id,a.dataset_key,a.condition,a.first_observed_at,a.last_observed_at,a.occurrence_count,
           h.health_state,r.pid,r.heartbeat_at,r.next_run_at,r.checkpoint_at,r.checkpoint_cursor,r.last_error,
           r.retry_count,r.pending_count,c.details coverage_details,g.checkpoint_reference,g.worker_name
    FROM dataset_alert_events a
    JOIN dataset_health_states h ON h.dataset_key=a.dataset_key
    LEFT JOIN dataset_runtime_observations r ON r.id=h.runtime_observation_id
    LEFT JOIN dataset_coverage_observations c ON c.id=h.coverage_observation_id
    JOIN dataset_registry g ON g.dataset_key=a.dataset_key
    WHERE a.status='OPEN' ORDER BY a.dataset_key,a.condition
  `);
  const prior = await priorRuntime();
  const decisions: Row[] = [];
  for (const row of rows) {
    const contract = actionContracts[row.dataset_key];
    const confidence = String(row.coverage_details?.confidence ?? "UNKNOWN") as Confidence;
    const lastAttempt = prior.INCIDENTS?.[row.incident_id];
    const cooldownMinutes = contract?.cooldown_minutes ?? 30;
    const cooldownActive = Boolean(lastAttempt?.completedAt && Date.now() - Date.parse(lastAttempt.completedAt) < cooldownMinutes * 60_000);
    const databaseOwnership = await readDatabaseOwnership(prisma, contract?.checkpoint_path ?? row.checkpoint_reference);
    const checkpointExists = databaseOwnership.supported ? databaseOwnership.checkpointExists : await exists(contract?.checkpoint_path ?? row.checkpoint_reference);
    const evidence: CandidateEvidence = {
      condition: row.condition, healthState: row.health_state, confidence, pending: databaseOwnership.supported ? databaseOwnership.pending : Number(row.pending_count ?? 0),
      pidConfirmedDead: Boolean(row.pid) && !pidAlive(row.pid), heartbeatStale: !row.heartbeat_at || Date.now() - new Date(row.heartbeat_at).valueOf() > 30 * 60_000,
      nextRunOverdue: Boolean(row.next_run_at) && Date.now() - new Date(row.next_run_at).valueOf() > 15 * 60_000,
      checkpointExists, liveDuplicateOwner: databaseOwnership.supported ? databaseOwnership.ownerActive || databaseOwnership.ambiguous : pidAlive(row.pid), actionContractKnown: Boolean(contract), transientFailure: isTransientError(row.last_error),
      retryCount: databaseOwnership.supported ? databaseOwnership.retryCount : Number(row.retry_count ?? 0), exactWritableAlternate: false, cooldownActive, attempts: Number(lastAttempt?.attempts ?? 0),
    };
    const decision = evaluateRemediationCandidate(evidence);
    const matchingContract = configuredContracts.find((item) => (item.registry_dataset_key ?? item.dataset_key) === row.dataset_key);
    const record = { datasetKey: row.dataset_key, incidentId: row.incident_id, condition: row.condition, confidence, contractId: matchingContract?.contract_id ?? null, contractVersion: matchingContract?.contract_version ?? null, contractStatus: matchingContract?.status ?? "NOT_CONFIGURED", contractConfidence: matchingContract?.confidence ?? "UNKNOWN", contractEnabled: matchingContract?.enabled ?? false, policyMatch: decision.eligible, rejectionReason: decision.reasons, ...decision, evidence };
    decisions.push(record);
    await audit({ event: "POLICY_EVALUATED", mode: live ? "LIVE" : "DRY_RUN", ...record });
  }
  const eligible = decisions.filter((item) => item.eligible);
  const incidents = { ...(prior.INCIDENTS ?? {}) };
  let actionsAttempted = 0, actionsSucceeded = 0, actionsFailed = 0;
  if (live && eligible.length) {
    const selected = eligible[0];
    const contract = actionContracts[selected.datasetKey];
    actionsAttempted = 1;
    const attempt = Number(incidents[selected.incidentId]?.attempts ?? 0) + 1;
    try {
      const verification = await executeContract(contract);
      actionsSucceeded = 1;
      incidents[selected.incidentId] = { attempts: attempt, completedAt: now(), result: "VERIFIED", verification };
      await audit({ event: "REMEDIATION_VERIFIED", datasetKey: selected.datasetKey, incidentId: selected.incidentId, contractId: contract.contract_id, attempt, verification });
    } catch (error) {
      actionsFailed = 1;
      const message = error instanceof Error ? error.message : String(error);
      incidents[selected.incidentId] = { attempts: attempt, completedAt: now(), result: attempt >= 3 ? "ESCALATED" : "FAILED", error: message };
      await audit({ event: "REMEDIATION_FAILED", datasetKey: selected.datasetKey, incidentId: selected.incidentId, contractId: contract?.contract_id, attempt, error: message });
    }
  }
  const escalations = Object.values(incidents).filter((item: any) => item.result === "ESCALATED").length;
  const result = { startedAt, completedAt: now(), mode: live ? "LIVE_ENABLED" : "POLICY_MATCH_ONLY", openAlertsEvaluated: rows.length, eligible: eligible.length, notEligible: rows.length - eligible.length, decisions, actionsAttempted, actionsSucceeded, actionsFailed, escalations };
  cycleCount += 1;
  await atomic({ PID: process.pid, INVOCATION_ID: invocationId, STATE: daemon ? "SCHEDULED_WAIT" : "COMPLETE", HEARTBEAT_AT: now(), LAST_CYCLE_AT: startedAt, LAST_SUCCESS_AT: result.completedAt, LAST_ERROR: null, NEXT_RUN_AT: daemon ? new Date(Date.now() + intervalMs).toISOString() : null, CYCLE_COUNT: Number(prior.CYCLE_COUNT ?? 0) + 1, SELF_HEALING_ENABLED: live, CONTRACT_CONFIG_VERSION: contractMetadata.version, CONTRACT_CONFIG_CHECKSUM: contractMetadata.checksum, CONTRACTS_LOADED: contractMetadata.count, CONTRACTS_LOADED_AT: now(), MAX_ATTEMPTS: 3, COOLDOWN_MINUTES: 30, ACTIONS_EVALUATED: rows.length, ACTIONS_ATTEMPTED: Number(prior.ACTIONS_ATTEMPTED ?? 0) + actionsAttempted, ACTIONS_SUCCEEDED: Number(prior.ACTIONS_SUCCEEDED ?? 0) + actionsSucceeded, ACTIONS_FAILED: Number(prior.ACTIONS_FAILED ?? 0) + actionsFailed, ESCALATIONS: escalations, INCIDENTS: incidents, LAST_RESULT: result });
  return result;
}

async function waitWithHeartbeat(): Promise<void> {
  const nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  while (!stopping && Date.now() < Date.parse(nextRunAt)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(60_000, Date.parse(nextRunAt) - Date.now())));
    if (!stopping) {
      const prior = await priorRuntime();
      await atomic({ ...prior, PID: process.pid, INVOCATION_ID: invocationId, STATE: "SCHEDULED_WAIT", HEARTBEAT_AT: now(), NEXT_RUN_AT: nextRunAt, SELF_HEALING_ENABLED: live });
    }
  }
}
async function main() { do { console.log(JSON.stringify(await cycle())); if (!daemon || stopping) break; await waitWithHeartbeat(); } while (!stopping); }
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopping = true; });
main().catch(async (error) => { await atomic({ PID: process.pid, INVOCATION_ID: invocationId, STATE: "DEGRADED", HEARTBEAT_AT: now(), LAST_ERROR: error instanceof Error ? error.message : String(error), SELF_HEALING_ENABLED: live }).catch(() => undefined); console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
