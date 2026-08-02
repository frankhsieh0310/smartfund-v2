import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { US_TREASURY_V1_CONTRACT } from "../../../lib/data-platform/providers/us-treasury/UsTreasuryAuctionsAdapter.ts";
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

const JOB_ID = US_TREASURY_V1_CONTRACT.incrementalJobId;
const MARKET = "US_TREASURY";
const RUN_TYPE = "INCREMENTAL";
const DRY_RUN = process.argv.includes("--dry-run");
const HEARTBEAT_MS = 60_000;
const MAX_UNIVERSE = Number.parseInt(process.env.BOND_MAX_UNIVERSE ?? "1000", 10);

type ImportReport = {
  status: string;
  snapshotDate: string;
  runId: string;
  selectedUniverse: number;
  processed: number;
  succeeded: number;
  failed: number;
  inserted: number;
  updated: number;
  noChange: number;
  databaseWrites: number;
  latestAvailableDate: string | null;
  checkpoint: string | null;
  failureQueue: string | Array<unknown>;
  unresolvedFailures: number;
  crossDomainWrites: number;
  durableArchive: { manifestPath: string; manifestHash: string; entries: number } | null;
  archiveReplay: { status: string; verifiedObjects: number } | null;
  coverageMatrix: { completedLayers: number; remainingLayers: number; artifact: string };
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

function summaryFrom(report: ImportReport): RunSummary {
  return {
    ...createSummary(),
    attempted: report.processed,
    completed: report.succeeded,
    inserted: report.inserted,
    updated: report.updated,
    failed: report.failed,
    success: report.succeeded,
    noUpdate: report.noChange,
    retryableFailure: report.unresolvedFailures,
    upToProviderLatest: report.succeeded,
  };
}

async function executeImporter(input: {
  runId: string;
  snapshot: string;
  outputRoot: string;
  onProgress?: (value: Record<string, unknown>) => Promise<void>;
}): Promise<{ exitCode: number; report: ImportReport }> {
  const args = [
    "--experimental-strip-types",
    "scripts/data/bond/import-us-treasury-v1.ts",
    "--incremental",
    DRY_RUN ? "--dry-run" : "--apply",
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
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBuffer = "";
  let stderr = "";
  let progressChain = Promise.resolve();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    process.stdout.write(chunk);
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.event === "BOND_V1_PROGRESS" && input.onProgress) {
          progressChain = progressChain.then(() => input.onProgress!(value));
        }
      } catch {
        // Pretty-printed final output is read from the durable report instead.
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    process.stderr.write(chunk);
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  await progressChain;
  const reportPath = path.join(input.outputRoot, "import-report.json");
  let report: ImportReport;
  try {
    report = await readJson<ImportReport>(reportPath);
  } catch (error) {
    throw new Error(`BOND_IMPORT_REPORT_UNAVAILABLE:${reportPath}:${stderr.slice(-500)}:${error instanceof Error ? error.message : String(error)}`);
  }
  return { exitCode, report };
}

async function syncFailureQueue(prisma: PrismaClient, report: ImportReport): Promise<void> {
  if (typeof report.failureQueue !== "string") return;
  const failures = await readJson<LocalFailure[]>(report.failureQueue);
  const unresolved = failures.filter((failure) => !failure.resolved);
  for (const failure of unresolved) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO production_scheduler_failures
        (job_id, stock_id, symbol, attempts, last_error, error_type, first_failed_at, last_attempted_at, next_retry_at, classification, resolved, resolution_reason)
       VALUES ($1, $2, $2, 1, $3, $4, NOW(), NOW(), CASE WHEN $5 THEN NOW() + INTERVAL '1 day' ELSE NULL END,
         CASE WHEN $5 THEN 'RETRYABLE_FAILURE' ELSE 'PERMANENT_UNAVAILABLE' END, NOT $5,
         CASE WHEN $5 THEN NULL ELSE $3 END)
       ON CONFLICT (job_id, stock_id) DO UPDATE SET
         symbol = EXCLUDED.symbol,
         attempts = CASE WHEN production_scheduler_failures.resolved THEN 1 ELSE production_scheduler_failures.attempts + 1 END,
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
  const ownership = await validateWorkerOwnershipFromEnvironment({
    domain: "BOND",
    market: MARKET,
    mode: "INCREMENTAL",
    dryRun: DRY_RUN,
  });
  const runtimeRoot = path.resolve(process.env.BOND_RUNTIME_ROOT ?? path.join("runtime", "bond", "us-treasury"));
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
  const owner = process.env.SMARTFUND_NODE_ID!;
  let lifecycleRunId: string | null = null;
  let lockAcquired = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  try {
    if (DRY_RUN) {
      const [locks, runs] = await Promise.all([
        prisma.$queryRawUnsafe<Array<{ owner: string; updated_at: Date; expires_at: Date }>>(
          "SELECT owner, updated_at, expires_at FROM production_scheduler_locks WHERE job_id = $1 AND expires_at > NOW() AND updated_at > NOW() - INTERVAL '10 minutes'",
          JOB_ID,
        ),
        prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
          "SELECT id, status FROM production_scheduler_runs WHERE job_id = $1 AND status IN ('RUNNING', 'IN_PROGRESS') ORDER BY started_at DESC",
          JOB_ID,
        ),
      ]);
      if (locks.length || runs.length) throw new Error(`BOND_DRY_RUN_OWNERSHIP_CONFLICT:locks=${locks.length}:runs=${runs.length}`);
      const dryRunId = randomUUID();
      const outputRoot = path.join(runtimeRoot, "dry-runs", dryRunId);
      const result = await executeImporter({ runId: dryRunId, snapshot, outputRoot });
      if (result.exitCode !== 0 || result.report.status !== "PASS" || result.report.databaseWrites !== 0 || result.report.crossDomainWrites !== 0) {
        throw new Error(`BOND_PRODUCTION_DRY_RUN_FAILED:exit=${result.exitCode}:status=${result.report.status}:writes=${result.report.databaseWrites}:crossDomain=${result.report.crossDomainWrites}`);
      }
      console.log(JSON.stringify({
        status: "PASS",
        mode: "PRODUCTION_WRAPPER_DRY_RUN",
        ownership,
        activeLockExists: false,
        lifecycleWrites: 0,
        databaseWrites: 0,
        selectedUniverse: result.report.selectedUniverse,
        outputRoot,
      }, null, 2));
      return;
    }

    if (!ownership.liveWriteAuthorized) throw new Error("BOND_PRODUCTION_LIVE_WRITE_NOT_AUTHORIZED");
    if (process.env.BOND_LIVE_WRITE_AUTHORIZED !== "true") throw new Error("BOND_LIVE_WRITE_AUTHORIZED_REQUIRED");
    if (!process.env.BOND_ARCHIVE_ROOT) throw new Error("BOND_ARCHIVE_ROOT_REQUIRED");
    if (!Number.isInteger(MAX_UNIVERSE) || MAX_UNIVERSE < 465) throw new Error(`BOND_MAX_UNIVERSE_INVALID:${MAX_UNIVERSE}`);

    lockAcquired = await acquireLifecycleLock(prisma, JOB_ID, owner);
    if (!lockAcquired) {
      console.log(JSON.stringify({ status: "SKIPPED_ACTIVE_LOCK", jobId: JOB_ID, owner }));
      return;
    }
    await recoverOrphanedLifecycleRun(prisma, JOB_ID);
    const runKey = `${JOB_ID}:${snapshot}`;
    const completed = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      "SELECT id FROM production_scheduler_runs WHERE run_key = $1 AND status = 'COMPLETED' LIMIT 1",
      runKey,
    );
    if (completed[0]) {
      console.log(JSON.stringify({ status: "SKIPPED_ALREADY_COMPLETED", jobId: JOB_ID, runId: completed[0].id, runKey }));
      return;
    }
    lifecycleRunId = await createLifecycleRun(prisma, JOB_ID, MARKET, RUN_TYPE, {
      targetTradeDate: new Date(`${snapshot}T00:00:00.000Z`),
      runKey,
      universeCount: 465,
    });
    heartbeatTimer = setInterval(() => {
      void heartbeatLifecycleLock(prisma, JOB_ID, owner).catch((error) => console.error("BOND_HEARTBEAT_FAILED", error));
    }, HEARTBEAT_MS);

    const outputRoot = path.join(runtimeRoot, "runs", lifecycleRunId);
    const result = await executeImporter({
      runId: lifecycleRunId,
      snapshot,
      outputRoot,
      onProgress: async (value) => {
        const summary = {
          ...createSummary(),
          attempted: Number(value.ATTEMPTED ?? 0),
          completed: Number(value.SUCCEEDED ?? 0),
          inserted: Number(value.ROWS_INSERTED ?? 0),
          updated: Number(value.ROWS_UPDATED ?? 0),
          failed: Number(value.FAILED ?? 0),
          success: Number(value.SUCCEEDED ?? 0),
          noUpdate: Number(value.ROWS_UNCHANGED ?? 0),
          retryableFailure: Number(value.RETRYABLE ?? 0),
          upToProviderLatest: Number(value.SUCCEEDED ?? 0),
        };
        await persistLifecycleCheckpoint(prisma, lifecycleRunId!, summary, String(value.CURRENT_SECURITY ?? "UNKNOWN"), {
          jobId: JOB_ID,
          targetTradeDate: new Date(`${snapshot}T00:00:00.000Z`),
          runType: RUN_TYPE,
        });
        await heartbeatLifecycleLock(prisma, JOB_ID, owner);
      },
    });
    if (result.report.selectedUniverse > MAX_UNIVERSE) throw new Error(`BOND_BOUNDED_UNIVERSE_EXCEEDED:${result.report.selectedUniverse}/${MAX_UNIVERSE}`);
    await syncFailureQueue(prisma, result.report);
    const summary = summaryFrom(result.report);
    const validation = {
      status: result.exitCode === 0
        && result.report.status.startsWith("PASS")
        && result.report.archiveReplay?.status === "PASS"
        && result.report.crossDomainWrites === 0
        ? "PASS"
        : "FAIL",
      ownership,
      archiveReplay: result.report.archiveReplay,
      durableArchive: result.report.durableArchive,
      crossDomainWrites: result.report.crossDomainWrites,
      coverageMatrix: result.report.coverageMatrix,
      checkpoint: result.report.checkpoint,
      failureQueue: result.report.failureQueue,
    };
    await completeLifecycleRun(
      prisma,
      lifecycleRunId,
      summary,
      result.report.latestAvailableDate ? new Date(`${result.report.latestAvailableDate}T00:00:00.000Z`) : null,
      validation,
    );
    console.log(JSON.stringify({
      status: validation.status,
      jobId: JOB_ID,
      lifecycleRunId,
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
      report: result.report,
    }, null, 2));
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
