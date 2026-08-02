import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { TAIWAN_GOVERNMENT_BOND_V1_CONTRACT } from "../../../lib/data-platform/providers/taiwan-government-bond/TaiwanGovernmentBondAdapter.ts";
import { validateWorkerOwnershipFromEnvironment } from "../governance/worker-ownership.ts";
import {
  acquireLifecycleLock,
  completeLifecycleRun,
  createLifecycleRun,
  createSummary,
  failLifecycleRun,
  heartbeatLifecycleLock,
  persistLifecycleCheckpoint,
  recoverOrphanedLifecycleRun,
  releaseLifecycleLock,
  type RunSummary,
} from "../production/run-lifecycle.ts";

const JOB_ID = TAIWAN_GOVERNMENT_BOND_V1_CONTRACT.incrementalJobId;
const MARKET = TAIWAN_GOVERNMENT_BOND_V1_CONTRACT.market;
const DRY_RUN = process.argv.includes("--dry-run");
const HEARTBEAT_MS = 60_000;
const MAX_UNIVERSE = Number.parseInt(process.env.BOND_MAX_UNIVERSE ?? "1000", 10);

type ImportResult = {
  status: string;
  jobId: string;
  runId: string;
  source: { sourceDate: string | null };
  universeDenominator: number;
  selected: number;
  checkpoint: {
    lastOfficialSecurityId: string | null;
    processed: number;
    succeeded: number;
    failed: number;
    inserted: number;
    updated: number;
    noChange: number;
  };
  failureQueue: { total: number; open: number; retryable: number };
  freshness: { records: number; denominator: number; measurable: number; freshOfficialSnapshots: number; secondaryMarketUnknown: number };
  databaseWrites: number;
  crossDomainWrites: number;
  archive: { manifestPath: string; manifestHash: string; entries: number } | null;
  archiveReplay: { status: string; verifiedObjects: number } | null;
};

type LocalFailure = {
  officialSecurityId: string;
  stage: string;
  error: string;
  retryable: boolean;
  resolved: boolean;
};

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function snapshotDate(): string {
  const value = argument("snapshot-date") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`INVALID_SNAPSHOT_DATE:${value}`);
  }
  return value;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function summaryFrom(result: ImportResult): RunSummary {
  return {
    ...createSummary(),
    attempted: result.checkpoint.processed,
    completed: result.checkpoint.succeeded,
    inserted: result.checkpoint.inserted,
    updated: result.checkpoint.updated,
    failed: result.checkpoint.failed,
    success: result.checkpoint.succeeded,
    noUpdate: result.checkpoint.noChange,
    retryableFailure: result.failureQueue.retryable,
    upToProviderLatest: result.freshness.freshOfficialSnapshots,
  };
}

async function executeImporter(input: { runId: string; snapshot: string; outputRoot: string }): Promise<{ exitCode: number; result: ImportResult }> {
  const args = [
    "--experimental-strip-types",
    "scripts/data/bond/import-taiwan-government-bond-v1.ts",
    "--incremental",
    DRY_RUN ? "--dry-run" : "--apply",
    "--count=197",
    "--full-universe",
    "--confirm-full-universe",
    `--snapshot-date=${input.snapshot}`,
    `--run-id=${input.runId}`,
  ];
  if (DRY_RUN) args.push(`--output-dir=${input.outputRoot}`);
  else args.push("--confirm-production-write", "--managed-lifecycle", "--durable-archive");
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BOND_PRODUCTION_SCHEDULER_ONLINE: "true",
      BOND_PRODUCTION_LIVE_RUN: DRY_RUN ? "false" : "true",
    },
    stdio: ["ignore", "inherit", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  const resultPath = path.join(input.outputRoot, "result.json");
  try {
    return { exitCode, result: await readJson<ImportResult>(resultPath) };
  } catch (error) {
    throw new Error(`TAIWAN_BOND_IMPORT_RESULT_UNAVAILABLE:${resultPath}:${stderr.slice(-500)}:${error instanceof Error ? error.message : String(error)}`);
  }
}

async function syncFailureQueue(prisma: PrismaClient, runtimeRoot: string): Promise<void> {
  let failures: LocalFailure[] = [];
  try {
    failures = await readJson<LocalFailure[]>(path.join(runtimeRoot, `${JOB_ID}-failures.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const unresolved = failures.filter((failure) => !failure.resolved);
  for (const failure of unresolved) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO production_scheduler_failures
        (job_id, stock_id, symbol, attempts, last_error, error_type, first_failed_at, last_attempted_at, next_retry_at, classification, resolved, resolution_reason)
       VALUES ($1, $2, $2, 1, $3, $4, NOW(), NOW(), CASE WHEN $5 THEN NOW() + INTERVAL '1 day' ELSE NULL END,
         CASE WHEN $5 THEN 'RETRYABLE_FAILURE' ELSE 'PERMANENT_UNAVAILABLE' END, NOT $5,
         CASE WHEN $5 THEN NULL ELSE $3 END)
       ON CONFLICT (job_id, stock_id) DO UPDATE SET
         attempts = production_scheduler_failures.attempts + 1,
         last_error = EXCLUDED.last_error,
         error_type = EXCLUDED.error_type,
         last_attempted_at = NOW(),
         next_retry_at = EXCLUDED.next_retry_at,
         classification = EXCLUDED.classification,
         resolved = EXCLUDED.resolved,
         resolved_at = CASE WHEN EXCLUDED.resolved THEN NOW() ELSE NULL END,
         resolution_reason = EXCLUDED.resolution_reason`,
      JOB_ID,
      failure.officialSecurityId,
      failure.error,
      failure.stage,
      failure.retryable,
    );
  }
  await prisma.$executeRawUnsafe(
    `UPDATE production_scheduler_failures
     SET resolved = TRUE, resolved_at = NOW(), resolution_reason = 'BOND_INCREMENTAL_RETRY_RECOVERED', next_retry_at = NULL
     WHERE job_id = $1 AND resolved = FALSE AND NOT (stock_id = ANY($2::text[]))`,
    JOB_ID,
    unresolved.map((failure) => failure.officialSecurityId),
  );
}

async function main(): Promise<void> {
  const snapshot = snapshotDate();
  const ownership = await validateWorkerOwnershipFromEnvironment({ domain: "BOND", market: MARKET, mode: "INCREMENTAL", dryRun: DRY_RUN });
  const runtimeRoot = path.resolve(process.env.TAIWAN_BOND_RUNTIME_ROOT ?? path.join("runtime", "bond", "taiwan-government"));
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
  const owner = process.env.SMARTFUND_NODE_ID!;
  let lifecycleRunId: string | null = null;
  let lockAcquired = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  try {
    if (DRY_RUN) {
      const [locks, runs] = await Promise.all([
        prisma.$queryRawUnsafe<Array<{ owner: string }>>("SELECT owner FROM production_scheduler_locks WHERE job_id = $1 AND expires_at > NOW() AND updated_at > NOW() - INTERVAL '10 minutes'", JOB_ID),
        prisma.$queryRawUnsafe<Array<{ id: string }>>("SELECT id FROM production_scheduler_runs WHERE job_id = $1 AND status IN ('RUNNING', 'IN_PROGRESS')", JOB_ID),
      ]);
      if (locks.length || runs.length) throw new Error(`TAIWAN_BOND_DRY_RUN_OWNERSHIP_CONFLICT:locks=${locks.length}:runs=${runs.length}`);
      const runId = randomUUID();
      const outputRoot = path.join(runtimeRoot, "dry-runs", runId);
      const executed = await executeImporter({ runId, snapshot, outputRoot });
      if (executed.exitCode !== 0 || executed.result.status !== "PASS" || executed.result.databaseWrites !== 0 || executed.result.crossDomainWrites !== 0) {
        throw new Error(`TAIWAN_BOND_PRODUCTION_DRY_RUN_FAILED:exit=${executed.exitCode}:status=${executed.result.status}:writes=${executed.result.databaseWrites}:crossDomain=${executed.result.crossDomainWrites}`);
      }
      console.log(JSON.stringify({ status: "PASS", mode: "PRODUCTION_WRAPPER_DRY_RUN", ownership, activeLockExists: false, lifecycleWrites: 0, databaseWrites: 0, selectedUniverse: executed.result.selected }, null, 2));
      return;
    }

    if (!ownership.liveWriteAuthorized) throw new Error("TAIWAN_BOND_PRODUCTION_LIVE_WRITE_NOT_AUTHORIZED");
    if (process.env.BOND_LIVE_WRITE_AUTHORIZED !== "true") throw new Error("BOND_LIVE_WRITE_AUTHORIZED_REQUIRED");
    if (!process.env.BOND_ARCHIVE_ROOT) throw new Error("BOND_ARCHIVE_ROOT_REQUIRED");
    if (!Number.isInteger(MAX_UNIVERSE) || MAX_UNIVERSE < 197) throw new Error(`BOND_MAX_UNIVERSE_INVALID:${MAX_UNIVERSE}`);
    lockAcquired = await acquireLifecycleLock(prisma, JOB_ID, owner);
    if (!lockAcquired) {
      console.log(JSON.stringify({ status: "SKIPPED_ACTIVE_LOCK", jobId: JOB_ID, owner }));
      return;
    }
    await recoverOrphanedLifecycleRun(prisma, JOB_ID);
    const runKey = `${JOB_ID}:${snapshot}`;
    const completed = await prisma.$queryRawUnsafe<Array<{ id: string }>>("SELECT id FROM production_scheduler_runs WHERE run_key = $1 AND status = 'COMPLETED' LIMIT 1", runKey);
    if (completed[0]) {
      console.log(JSON.stringify({ status: "SKIPPED_ALREADY_COMPLETED", jobId: JOB_ID, runId: completed[0].id, runKey }));
      return;
    }
    lifecycleRunId = await createLifecycleRun(prisma, JOB_ID, MARKET, "INCREMENTAL", {
      targetTradeDate: new Date(`${snapshot}T00:00:00.000Z`),
      runKey,
      universeCount: 197,
    });
    heartbeatTimer = setInterval(() => void heartbeatLifecycleLock(prisma, JOB_ID, owner).catch((error) => console.error("TAIWAN_BOND_HEARTBEAT_FAILED", error)), HEARTBEAT_MS);
    const outputRoot = path.join(runtimeRoot, "runs", lifecycleRunId);
    const executed = await executeImporter({ runId: lifecycleRunId, snapshot, outputRoot });
    if (executed.result.selected > MAX_UNIVERSE) throw new Error(`TAIWAN_BOND_BOUNDED_UNIVERSE_EXCEEDED:${executed.result.selected}/${MAX_UNIVERSE}`);
    await syncFailureQueue(prisma, runtimeRoot);
    const summary = summaryFrom(executed.result);
    await persistLifecycleCheckpoint(prisma, lifecycleRunId, summary, executed.result.checkpoint.lastOfficialSecurityId ?? "UNKNOWN", {
      jobId: JOB_ID,
      targetTradeDate: new Date(`${snapshot}T00:00:00.000Z`),
      runType: "INCREMENTAL",
    });
    const validation = {
      status: executed.exitCode === 0
        && executed.result.status === "PASS"
        && executed.result.archiveReplay?.status === "PASS"
        && executed.result.crossDomainWrites === 0
        && executed.result.freshness.measurable === executed.result.freshness.denominator
        ? "PASS"
        : "FAIL",
      ownership,
      archiveReplay: executed.result.archiveReplay,
      archive: executed.result.archive,
      freshness: executed.result.freshness,
      crossDomainWrites: executed.result.crossDomainWrites,
      checkpoint: executed.result.checkpoint.lastOfficialSecurityId,
      failureQueue: executed.result.failureQueue,
    };
    await completeLifecycleRun(
      prisma,
      lifecycleRunId,
      summary,
      executed.result.source.sourceDate ? new Date(`${executed.result.source.sourceDate}T00:00:00.000Z`) : null,
      validation,
    );
    console.log(JSON.stringify({ status: validation.status, jobId: JOB_ID, lifecycleRunId, deploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null, result: executed.result }, null, 2));
    if (validation.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    if (lifecycleRunId) await failLifecycleRun(prisma, lifecycleRunId, error);
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lockAcquired) await releaseLifecycleLock(prisma, JOB_ID, owner);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
