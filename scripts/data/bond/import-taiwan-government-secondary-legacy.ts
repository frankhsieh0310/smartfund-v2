import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { DurableFileArchive } from "../../../lib/data-platform/archive/DurableFileArchive.ts";
import {
  parseTaiwanGovernmentBondSecondaryLegacyHtml,
  TaiwanGovernmentBondSecondaryMarketAdapter,
  TAIWAN_GOVERNMENT_BOND_SECONDARY_NAMESPACE,
  TAIWAN_GOVERNMENT_BOND_SECONDARY_PARSER_VERSION,
  type TaiwanGovernmentBondSecondaryObservation,
} from "../../../lib/data-platform/providers/taiwan-government-bond/TaiwanGovernmentBondSecondaryMarketAdapter.ts";
import { validateWorkerOwnershipFromEnvironment } from "../governance/worker-ownership.ts";

const JOB_ID = "official-bond-taiwan-government-secondary-legacy-historical";

type Checkpoint = {
  jobId: string;
  runId: string;
  checkedDates: string[];
  completedReportDates: string[];
  noReportDates: string[];
  observedSecurityIds: string[];
  observationRows: number;
  completed: boolean;
  updatedAt: string;
};

type Failure = { date: string; error: string; attempts: number; retryable: boolean; resolved: boolean; firstFailedAt: string; lastAttemptedAt: string };

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function assertDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`INVALID_${field}:${value}`);
  return value;
}

function weekdays(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let value = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); value <= end; value += 86_400_000) {
    const date = new Date(value);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(filePath, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function lock(lockPath: string, runId: string): Promise<FileHandle> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, "wx");
  await handle.writeFile(JSON.stringify({ jobId: JOB_ID, runId, nodeId: process.env.SMARTFUND_NODE_ID, pid: process.pid, acquiredAt: new Date().toISOString() }));
  return handle;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  if (dryRun === apply) throw new Error("EXACTLY_ONE_MODE_REQUIRED");
  if (apply && !process.argv.includes("--confirm-archive-write")) throw new Error("CONFIRM_ARCHIVE_WRITE_REQUIRED");
  const from = assertDate(argument("from-date") ?? "2001-11-20", "FROM_DATE");
  const to = assertDate(argument("to-date") ?? "2005-05-20", "TO_DATE");
  if (from > to) throw new Error(`DATE_RANGE_INVALID:${from}:${to}`);
  const maxDates = Number.parseInt(argument("max-dates") ?? "999999", 10);
  if (!Number.isInteger(maxDates) || maxDates < 1) throw new Error(`MAX_DATES_INVALID:${maxDates}`);
  const ownership = await validateWorkerOwnershipFromEnvironment({ domain: "BOND", market: "TAIWAN_GOVERNMENT", mode: "HISTORICAL", dryRun });
  if (apply && !ownership.liveWriteAuthorized) throw new Error("OWNERSHIP_LIVE_WRITE_NOT_AUTHORIZED");
  const runtimeRoot = path.resolve(process.env.TAIWAN_BOND_SECONDARY_RUNTIME_ROOT ?? path.join("runtime", "bond", "taiwan-government-secondary"));
  const runId = randomUUID();
  const outputRoot = dryRun ? path.join("debug", "bond", "taiwan-government-secondary-legacy", runId) : path.join(runtimeRoot, "legacy-runs", runId);
  const checkpointPath = path.join(runtimeRoot, `${JOB_ID}-checkpoint.json`);
  const failurePath = path.join(runtimeRoot, `${JOB_ID}-failures.json`);
  const lockPath = path.join(runtimeRoot, `${JOB_ID}.lock.json`);
  await mkdir(outputRoot, { recursive: true });
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
  let handle: FileHandle | null = null;
  try {
    const [activeLocks, activeRuns] = await Promise.all([
      prisma.$queryRawUnsafe<Array<{ owner: string }>>("SELECT owner FROM production_scheduler_locks WHERE job_id=$1 AND expires_at>NOW() AND updated_at>NOW()-INTERVAL '10 minutes'", JOB_ID),
      prisma.$queryRawUnsafe<Array<{ id: string }>>("SELECT id FROM production_scheduler_runs WHERE job_id=$1 AND status IN ('RUNNING','IN_PROGRESS')", JOB_ID),
    ]);
    if (activeLocks.length || activeRuns.length) throw new Error(`ACTIVE_LEGACY_JOB_CONFLICT:locks=${activeLocks.length}:runs=${activeRuns.length}`);
    if (apply) handle = await lock(lockPath, runId);
    const checkpoint = dryRun ? {
      jobId: JOB_ID, runId, checkedDates: [], completedReportDates: [], noReportDates: [], observedSecurityIds: [], observationRows: 0, completed: false, updatedAt: new Date().toISOString(),
    } satisfies Checkpoint : await readJson<Checkpoint>(checkpointPath, {
      jobId: JOB_ID, runId, checkedDates: [], completedReportDates: [], noReportDates: [], observedSecurityIds: [], observationRows: 0, completed: false, updatedAt: new Date().toISOString(),
    });
    checkpoint.runId = runId;
    checkpoint.completed = false;
    const checked = new Set(checkpoint.checkedDates);
    const completed = new Set(checkpoint.completedReportDates);
    const noReport = new Set(checkpoint.noReportDates);
    const securityIds = new Set(checkpoint.observedSecurityIds);
    const failures = await readJson<Failure[]>(failurePath, []);
    const adapter = new TaiwanGovernmentBondSecondaryMarketAdapter();
    const durable = apply ? new DurableFileArchive({ root: process.env.BOND_ARCHIVE_ROOT ?? path.join(runtimeRoot, "durable-archive"), prefix: "taiwan-government/secondary-market/legacy-v1" }) : null;
    let processed = 0;
    let rowsThisRun = 0;
    let reportsThisRun = 0;
    let noReportThisRun = 0;
    for (const date of weekdays(from, to)) {
      if (processed >= maxDates) break;
      if (checked.has(date)) continue;
      processed += 1;
      try {
        const source = await adapter.fetchLegacyHtml(date);
        checked.add(date);
        if (!source) {
          noReport.add(date);
          noReportThisRun += 1;
        } else {
          const parsed = parseTaiwanGovernmentBondSecondaryLegacyHtml(source.bytes, date);
          const rawPath = path.join(outputRoot, "raw", date.slice(0, 7), `DYS01.${date}.html`);
          const normalizedPath = path.join(outputRoot, "normalized", date.slice(0, 7), `${date}.json`);
          await mkdir(path.dirname(rawPath), { recursive: true });
          await writeFile(rawPath, source.bytes);
          await writeJson(normalizedPath, parsed.observations);
          if (durable) {
            const archive = await durable.archiveRun({ runId: `${runId}-${date}`, sourceNamespace: TAIWAN_GOVERNMENT_BOND_SECONDARY_NAMESPACE, parserVersion: `${TAIWAN_GOVERNMENT_BOND_SECONDARY_PARSER_VERSION}-legacy`, files: [
              { localPath: rawPath, logicalPath: `raw/${date.slice(0, 7)}/${path.basename(rawPath)}`, contentType: "text/html; charset=big5", sourceDocumentId: `DYS01:${date}`, sourceUpdatedAt: date, fetchedAt: new Date().toISOString() },
              { localPath: normalizedPath, logicalPath: `normalized/${date.slice(0, 7)}/${date}.json`, contentType: "application/json", sourceDocumentId: `DYS01:${date}`, sourceUpdatedAt: date, fetchedAt: new Date().toISOString() },
            ] });
            const replay = await durable.restoreAndReplay(archive.manifestPath);
            if (replay.status !== "PASS") throw new Error(`LEGACY_ARCHIVE_REPLAY_FAILED:${date}`);
          }
          completed.add(date);
          reportsThisRun += 1;
          rowsThisRun += parsed.observations.length;
          checkpoint.observationRows += parsed.observations.length;
          for (const row of parsed.observations) securityIds.add(row.officialSecurityId);
        }
        const prior = failures.find((row) => row.date === date);
        if (prior) prior.resolved = true;
      } catch (error) {
        const now = new Date().toISOString();
        const prior = failures.find((row) => row.date === date);
        const next: Failure = { date, error: error instanceof Error ? error.message : String(error), attempts: (prior?.attempts ?? 0) + 1, retryable: true, resolved: false, firstFailedAt: prior?.firstFailedAt ?? now, lastAttemptedAt: now };
        if (prior) Object.assign(prior, next); else failures.push(next);
      }
      checkpoint.checkedDates = [...checked].sort();
      checkpoint.completedReportDates = [...completed].sort();
      checkpoint.noReportDates = [...noReport].sort();
      checkpoint.observedSecurityIds = [...securityIds].sort();
      checkpoint.updatedAt = new Date().toISOString();
      if (apply && processed % 25 === 0) { await writeJson(checkpointPath, checkpoint); await writeJson(failurePath, failures); }
    }
    const candidates = weekdays(from, to);
    const openFailures = failures.filter((row) => !row.resolved);
    checkpoint.completed = candidates.every((date) => checked.has(date)) && openFailures.length === 0;
    checkpoint.updatedAt = new Date().toISOString();
    if (apply) { await writeJson(checkpointPath, checkpoint); await writeJson(failurePath, failures); }
    const result = {
      status: openFailures.length ? "COMPLETE_WITH_EXCEPTIONS" : "PASS",
      mode: dryRun ? "DRY_RUN" : "ARCHIVE_APPLY",
      jobId: JOB_ID,
      ownership,
      range: { from, to, candidateWeekdays: candidates.length },
      processedThisRun: processed,
      reportsThisRun,
      noReportThisRun,
      observationRowsThisRun: rowsThisRun,
      coverage: { checked: checked.size, denominator: candidates.length, percent: checked.size / candidates.length * 100 },
      historical: { reports: completed.size, rows: checkpoint.observationRows, securities: securityIds.size, earliest: [...completed].sort().at(0) ?? null, latest: [...completed].sort().at(-1) ?? null },
      failureQueue: { total: failures.length, open: openFailures.length },
      databaseWrites: 0,
      archiveReplay: apply && reportsThisRun ? "PASS" : "NOT_APPLICABLE",
      checkpoint: { completed: checkpoint.completed, updatedAt: checkpoint.updatedAt },
    };
    await writeJson(path.join(outputRoot, "result.json"), result);
    console.log(JSON.stringify(result, null, 2));
    if (openFailures.length) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
    if (handle) { await handle.close(); await unlink(lockPath).catch(() => undefined); }
  }
}

main().catch((error) => { console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error)); process.exitCode = 1; });
