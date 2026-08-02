import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { DurableFileArchive, type DurableArchiveResult } from "../../../lib/data-platform/archive/DurableFileArchive.ts";
import { TaiwanGovernmentBondAdapter } from "../../../lib/data-platform/providers/taiwan-government-bond/TaiwanGovernmentBondAdapter.ts";
import {
  parseTaiwanGovernmentBondSecondaryOds,
  TaiwanGovernmentBondSecondaryMarketAdapter,
  TAIWAN_GOVERNMENT_BOND_SECONDARY_JOB_ID,
  TAIWAN_GOVERNMENT_BOND_SECONDARY_NAMESPACE,
  TAIWAN_GOVERNMENT_BOND_SECONDARY_PARSER_VERSION,
  type TaiwanGovernmentBondSecondaryObservation,
} from "../../../lib/data-platform/providers/taiwan-government-bond/TaiwanGovernmentBondSecondaryMarketAdapter.ts";
import { validateWorkerOwnershipFromEnvironment } from "../governance/worker-ownership.ts";

type Checkpoint = {
  jobId: string;
  runId: string;
  fromMonth: string;
  toMonth: string;
  discoveredReportDates: string[];
  completedReportDates: string[];
  observedSecurityIds: string[];
  unregisteredHistoricalSecurityIds: string[];
  reportStats: Record<string, { observationRows: number; securityIds: string[]; unregisteredHistoricalSecurityIds: string[]; excludedCrossDomainRows: number }>;
  reportsDiscovered: number;
  reportsCompleted: number;
  observationRows: number;
  excludedCrossDomainRows: number;
  lastReportDate: string | null;
  completed: boolean;
  updatedAt: string;
};

type Failure = {
  reportDate: string;
  stage: string;
  error: string;
  attempts: number;
  retryable: boolean;
  resolved: boolean;
  firstFailedAt: string;
  lastAttemptedAt: string;
};

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function assertMonth(value: string, name: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(`INVALID_${name.toUpperCase()}:${value}`);
  return value;
}

function months(from: string, to: string): string[] {
  const [fromYear, fromMonth] = from.split("-").map(Number);
  const [toYear, toMonth] = to.split("-").map(Number);
  const start = fromYear * 12 + fromMonth - 1;
  const end = toYear * 12 + toMonth - 1;
  if (end < start) throw new Error(`MONTH_RANGE_INVALID:${from}:${to}`);
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const value = start + index;
    return `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, "0")}`;
  });
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function acquireLocalLock(lockPath: string, runId: string): Promise<FileHandle> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, "wx");
  await handle.writeFile(`${JSON.stringify({ jobId: TAIWAN_GOVERNMENT_BOND_SECONDARY_JOB_ID, runId, nodeId: process.env.SMARTFUND_NODE_ID, pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2)}\n`);
  return handle;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  if (dryRun === apply) throw new Error("EXACTLY_ONE_MODE_REQUIRED:--dry-run_OR_--apply");
  if (apply && !process.argv.includes("--confirm-archive-write")) throw new Error("CONFIRM_ARCHIVE_WRITE_REQUIRED");
  const currentMonth = new Date().toISOString().slice(0, 7);
  const fromMonth = assertMonth(argument("from-month") ?? "2005-07", "from-month");
  const toMonth = assertMonth(argument("to-month") ?? currentMonth, "to-month");
  const maxReports = Number.parseInt(argument("max-reports") ?? "999999", 10);
  if (!Number.isInteger(maxReports) || maxReports < 1) throw new Error(`MAX_REPORTS_INVALID:${maxReports}`);
  const reportDate = argument("report-date");
  if (reportDate && (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !reportDate.startsWith(`${fromMonth}-`) || fromMonth !== toMonth)) {
    throw new Error(`REPORT_DATE_SCOPE_INVALID:${reportDate}:${fromMonth}:${toMonth}`);
  }
  const ownership = await validateWorkerOwnershipFromEnvironment({ domain: "BOND", market: "TAIWAN_GOVERNMENT", mode: "HISTORICAL", dryRun });
  if (apply && !ownership.liveWriteAuthorized) throw new Error("OWNERSHIP_LIVE_WRITE_NOT_AUTHORIZED");

  const runtimeRoot = path.resolve(process.env.TAIWAN_BOND_SECONDARY_RUNTIME_ROOT ?? path.join("runtime", "bond", "taiwan-government-secondary"));
  const runId = argument("run-id") ?? randomUUID();
  const outputRoot = dryRun
    ? path.resolve(argument("output-dir") ?? path.join("debug", "bond", "taiwan-government-secondary", runId))
    : path.join(runtimeRoot, "runs", runId);
  const checkpointPath = path.join(runtimeRoot, `${TAIWAN_GOVERNMENT_BOND_SECONDARY_JOB_ID}-checkpoint.json`);
  const failurePath = path.join(runtimeRoot, `${TAIWAN_GOVERNMENT_BOND_SECONDARY_JOB_ID}-failures.json`);
  const lockPath = path.join(runtimeRoot, `${TAIWAN_GOVERNMENT_BOND_SECONDARY_JOB_ID}.lock.json`);
  await mkdir(outputRoot, { recursive: true });

  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
  let localLock: FileHandle | null = null;
  try {
    const [activeLocks, activeRuns, canonicalTables] = await Promise.all([
      prisma.$queryRawUnsafe<Array<{ owner: string }>>(
        "SELECT owner FROM production_scheduler_locks WHERE job_id = $1 AND expires_at > NOW() AND updated_at > NOW() - INTERVAL '10 minutes'",
        TAIWAN_GOVERNMENT_BOND_SECONDARY_JOB_ID,
      ),
      prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        "SELECT id,status FROM production_scheduler_runs WHERE job_id = $1 AND status IN ('RUNNING','IN_PROGRESS')",
        TAIWAN_GOVERNMENT_BOND_SECONDARY_JOB_ID,
      ),
      prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('bond_market_observations','bond_price_history')",
      ),
    ]);
    if (activeLocks.length || activeRuns.length) throw new Error(`ACTIVE_SECONDARY_JOB_CONFLICT:locks=${activeLocks.length}:runs=${activeRuns.length}`);
    if (apply) localLock = await acquireLocalLock(lockPath, runId);

    const universeResponse = await new TaiwanGovernmentBondAdapter().fetch();
    const allowedSecurityIds = new Set(universeResponse.bonds.map((row) => row.BondCode.trim()).filter(Boolean));
    if (allowedSecurityIds.size !== 197) throw new Error(`TAIWAN_GOVERNMENT_UNIVERSE_CHANGED:${allowedSecurityIds.size}:expected=197`);
    const adapter = new TaiwanGovernmentBondSecondaryMarketAdapter();
    const monthQueue = months(fromMonth, toMonth);
    const checkpoint = dryRun
      ? {
          jobId: TAIWAN_GOVERNMENT_BOND_SECONDARY_JOB_ID, runId, fromMonth, toMonth,
          discoveredReportDates: [], completedReportDates: [], observedSecurityIds: [], unregisteredHistoricalSecurityIds: [], reportStats: {}, reportsDiscovered: 0, reportsCompleted: 0,
          observationRows: 0, excludedCrossDomainRows: 0, lastReportDate: null, completed: false, updatedAt: new Date().toISOString(),
        } satisfies Checkpoint
      : await readJson<Checkpoint>(checkpointPath, {
          jobId: TAIWAN_GOVERNMENT_BOND_SECONDARY_JOB_ID, runId, fromMonth, toMonth,
          discoveredReportDates: [], completedReportDates: [], observedSecurityIds: [], unregisteredHistoricalSecurityIds: [], reportStats: {}, reportsDiscovered: 0, reportsCompleted: 0,
          observationRows: 0, excludedCrossDomainRows: 0, lastReportDate: null, completed: false, updatedAt: new Date().toISOString(),
        });
    if (checkpoint.jobId !== TAIWAN_GOVERNMENT_BOND_SECONDARY_JOB_ID) throw new Error("CHECKPOINT_JOB_MISMATCH");
    checkpoint.reportStats ??= {};
    checkpoint.runId = runId;
    checkpoint.fromMonth = fromMonth < checkpoint.fromMonth ? fromMonth : checkpoint.fromMonth;
    checkpoint.toMonth = toMonth > checkpoint.toMonth ? toMonth : checkpoint.toMonth;
    const completedBeforeRun = checkpoint.completed;
    if (!reportDate) checkpoint.completed = false;
    const completedDates = new Set(checkpoint.completedReportDates);
    const discoveredDates = new Set(checkpoint.discoveredReportDates ?? []);
    const observedSecurityIds = new Set(checkpoint.observedSecurityIds);
    const unregisteredHistoricalSecurityIds = new Set(checkpoint.unregisteredHistoricalSecurityIds ?? []);
    if (process.argv.includes("--reprocess-completed")) {
      if (!reportDate || !apply) throw new Error("REPROCESS_COMPLETED_REQUIRES_APPLY_REPORT_DATE");
      if (completedDates.has(reportDate)) {
        delete checkpoint.reportStats[reportDate];
        completedDates.delete(reportDate);
        const retainedStats = Object.values(checkpoint.reportStats);
        checkpoint.observationRows = retainedStats.reduce((sum, row) => sum + row.observationRows, 0);
        checkpoint.excludedCrossDomainRows = retainedStats.reduce((sum, row) => sum + row.excludedCrossDomainRows, 0);
        checkpoint.reportsCompleted = retainedStats.length;
        observedSecurityIds.clear();
        unregisteredHistoricalSecurityIds.clear();
        for (const stats of retainedStats) {
          for (const id of stats.securityIds) observedSecurityIds.add(id);
          for (const id of stats.unregisteredHistoricalSecurityIds) unregisteredHistoricalSecurityIds.add(id);
        }
      }
    }
    const failures = await readJson<Failure[]>(failurePath, []);
    let processedThisRun = 0;
    let discoveredThisRun = 0;
    let observationsThisRun = 0;
    let excludedThisRun = 0;
    const archives: DurableArchiveResult[] = [];
    const durable = apply ? new DurableFileArchive({
      root: process.env.BOND_ARCHIVE_ROOT ?? path.join(runtimeRoot, "durable-archive"),
      prefix: process.env.TAIWAN_BOND_SECONDARY_ARCHIVE_PREFIX ?? "taiwan-government/secondary-market/v1",
    }) : null;

    for (const month of monthQueue) {
      if (processedThisRun >= maxReports) break;
      let reports;
      try {
        reports = await adapter.discoverMonth(month);
        if (reportDate) reports = reports.filter((report) => report.date === reportDate);
      } catch (error) {
        const now = new Date().toISOString();
        const prior = failures.find((row) => row.reportDate === month && row.stage === "MONTH_DISCOVERY");
        const next: Failure = { reportDate: month, stage: "MONTH_DISCOVERY", error: error instanceof Error ? error.message : String(error), attempts: (prior?.attempts ?? 0) + 1, retryable: true, resolved: false, firstFailedAt: prior?.firstFailedAt ?? now, lastAttemptedAt: now };
        if (prior) Object.assign(prior, next); else failures.push(next);
        if (apply) await writeJson(failurePath, failures);
        continue;
      }
      discoveredThisRun += reports.length;
      for (const report of reports) discoveredDates.add(report.date);
      const monthFiles: Array<{ localPath: string; logicalPath: string; contentType: string; sourceDocumentId: string; sourceUpdatedAt: string; fetchedAt: string }> = [];
      const monthObservations: TaiwanGovernmentBondSecondaryObservation[] = [];
      for (const report of reports) {
        if (processedThisRun >= maxReports) break;
        if (completedDates.has(report.date)) continue;
        processedThisRun += 1;
        const fetchedAt = new Date().toISOString();
        try {
          const ods = await adapter.fetchOds(report);
          const parsed = parseTaiwanGovernmentBondSecondaryOds(ods, report, allowedSecurityIds, fetchedAt);
          const rawPath = path.join(outputRoot, "raw", month, `BDdys01a.${report.date.replaceAll("-", "")}-C.ods`);
          await mkdir(path.dirname(rawPath), { recursive: true });
          await writeFile(rawPath, ods);
          monthFiles.push({ localPath: rawPath, logicalPath: `raw/${month}/${path.basename(rawPath)}`, contentType: "application/vnd.oasis.opendocument.spreadsheet", sourceDocumentId: `BDdys01a:${report.date}`, sourceUpdatedAt: report.date, fetchedAt });
          monthObservations.push(...parsed.observations);
          observationsThisRun += parsed.observations.length;
          excludedThisRun += parsed.excludedSecurityIds.length;
          for (const row of parsed.observations) observedSecurityIds.add(row.officialSecurityId);
          for (const id of parsed.unregisteredHistoricalSecurityIds) unregisteredHistoricalSecurityIds.add(id);
          checkpoint.reportStats[report.date] = {
            observationRows: parsed.observations.length,
            securityIds: [...new Set(parsed.observations.map((row) => row.officialSecurityId))].sort(),
            unregisteredHistoricalSecurityIds: parsed.unregisteredHistoricalSecurityIds,
            excludedCrossDomainRows: parsed.excludedSecurityIds.length,
          };
          completedDates.add(report.date);
          checkpoint.reportsCompleted += 1;
          checkpoint.observationRows += parsed.observations.length;
          checkpoint.excludedCrossDomainRows += parsed.excludedSecurityIds.length;
          checkpoint.lastReportDate = report.date;
          const prior = failures.find((row) => row.reportDate === report.date && row.stage === "REPORT_IMPORT");
          if (prior) prior.resolved = true;
        } catch (error) {
          const now = new Date().toISOString();
          const prior = failures.find((row) => row.reportDate === report.date && row.stage === "REPORT_IMPORT");
          const next: Failure = { reportDate: report.date, stage: "REPORT_IMPORT", error: error instanceof Error ? error.message : String(error), attempts: (prior?.attempts ?? 0) + 1, retryable: true, resolved: false, firstFailedAt: prior?.firstFailedAt ?? now, lastAttemptedAt: now };
          if (prior) Object.assign(prior, next); else failures.push(next);
        }
        checkpoint.completedReportDates = [...completedDates].sort();
        checkpoint.discoveredReportDates = [...discoveredDates].sort();
        checkpoint.observedSecurityIds = [...observedSecurityIds].sort();
        checkpoint.unregisteredHistoricalSecurityIds = [...unregisteredHistoricalSecurityIds].sort();
        checkpoint.updatedAt = new Date().toISOString();
        if (apply && processedThisRun % 25 === 0) {
          await writeJson(checkpointPath, checkpoint);
          await writeJson(failurePath, failures);
        }
      }
      if (monthFiles.length) {
        const normalizedPath = path.join(outputRoot, "normalized", `${month}.json`);
        await writeJson(normalizedPath, monthObservations);
        monthFiles.push({ localPath: normalizedPath, logicalPath: `normalized/${month}.json`, contentType: "application/json", sourceDocumentId: `BDdys01a:${month}`, sourceUpdatedAt: month, fetchedAt: new Date().toISOString() });
        if (durable) {
          const archive = await durable.archiveRun({ runId: `${runId}-${month}`, sourceNamespace: TAIWAN_GOVERNMENT_BOND_SECONDARY_NAMESPACE, parserVersion: TAIWAN_GOVERNMENT_BOND_SECONDARY_PARSER_VERSION, files: monthFiles });
          const replay = await durable.restoreAndReplay(archive.manifestPath);
          if (replay.status !== "PASS") throw new Error(`DURABLE_ARCHIVE_REPLAY_FAILED:${month}`);
          archives.push(archive);
        }
        if (apply) {
          await writeJson(checkpointPath, checkpoint);
          await writeJson(failurePath, failures);
        }
      }
    }

    checkpoint.discoveredReportDates = [...discoveredDates].sort();
    checkpoint.reportsDiscovered = discoveredDates.size;
    const openFailures = failures.filter((row) => !row.resolved);
    const reachedBound = processedThisRun >= maxReports;
    const requestedDiscoveredDates = [...discoveredDates].filter((date) => date >= `${fromMonth}-01` && date <= `${toMonth}-31` && (!reportDate || date === reportDate));
    const rangeWasFullyVisited = reportDate ? true : discoveredThisRun === 0 ? monthQueue.every((month) => checkpoint.discoveredReportDates.some((date) => date.startsWith(`${month}-`))) : processedThisRun < maxReports;
    checkpoint.completed = reportDate
      ? completedBeforeRun
      : rangeWasFullyVisited && openFailures.length === 0 && requestedDiscoveredDates.every((date) => completedDates.has(date));
    checkpoint.updatedAt = new Date().toISOString();
    if (apply) {
      await writeJson(checkpointPath, checkpoint);
      await writeJson(failurePath, failures);
    }
    const completedDatesSorted = [...completedDates].sort();
    const result = {
      status: openFailures.length ? "COMPLETE_WITH_EXCEPTIONS" : "PASS",
      mode: dryRun ? "DRY_RUN" : "ARCHIVE_APPLY",
      jobId: TAIWAN_GOVERNMENT_BOND_SECONDARY_JOB_ID,
      runId,
      ownership,
      source: {
        provider: "Taipei Exchange (TPEx)",
        discoveryEndpoint: "https://www.tpex.org.tw/www/zh-tw/bond/govDaily",
        fileCode: "BDdys01a",
        officialHistoricalStart: "2005-07",
      },
      universe: {
        currentIssuanceMaster: { numerator: allowedSecurityIds.size, denominator: 197, percent: allowedSecurityIds.size / 197 * 100 },
        historicalSecondaryDiscovered: observedSecurityIds.size,
        historicalNotInCurrentMaster: unregisteredHistoricalSecurityIds.size,
      },
      reports: { discoveredThisRun, processedThisRun, completedAllRuns: completedDates.size },
      observations: { rowsThisRun: observationsThisRun, rowsAllRuns: checkpoint.observationRows, securitiesAllRuns: observedSecurityIds.size, earliest: completedDatesSorted.at(0) ?? null, latest: completedDatesSorted.at(-1) ?? null },
      crossDomain: { excludedRowsThisRun: excludedThisRun, excludedRowsAllRuns: checkpoint.excludedCrossDomainRows, databaseWrites: 0 },
      checkpoint,
      failureQueue: { total: failures.length, open: openFailures.length, retryable: openFailures.filter((row) => row.retryable).length },
      archive: { manifestsThisRun: archives.length, entriesThisRun: archives.reduce((sum, row) => sum + row.entries, 0), replay: archives.length ? "PASS" : dryRun ? "NOT_APPLICABLE" : "NO_NEW_FILES" },
      canonicalDatabase: { observationTablesFound: canonicalTables.map((row) => row.table_name), writes: 0, status: canonicalTables.length ? "AVAILABLE_NOT_USED_PENDING_REVIEW" : "BLOCKED_BY_SCHEMA" },
      idempotent: completedDates.size === checkpoint.completedReportDates.length,
      nextAction: checkpoint.completed ? "VALIDATE_FULL_RANGE_AND_BUILD_LATEST_INCREMENTAL" : reachedBound ? "RESUME_REMAINING_REPORTS" : openFailures.length ? "RETRY_FAILURE_QUEUE" : "RESUME_REMAINING_REPORTS",
    };
    await writeJson(path.join(outputRoot, "result.json"), result);
    console.log(JSON.stringify({
      ...result,
      checkpoint: {
        jobId: checkpoint.jobId,
        runId: checkpoint.runId,
        fromMonth: checkpoint.fromMonth,
        toMonth: checkpoint.toMonth,
        reportsDiscovered: checkpoint.reportsDiscovered,
        reportsCompleted: checkpoint.reportsCompleted,
        observationRows: checkpoint.observationRows,
        historicalSecurityCount: checkpoint.observedSecurityIds.length,
        unregisteredHistoricalSecurityCount: checkpoint.unregisteredHistoricalSecurityIds.length,
        lastReportDate: checkpoint.lastReportDate,
        completed: checkpoint.completed,
        updatedAt: checkpoint.updatedAt,
      },
    }, null, 2));
    if (openFailures.length) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
    if (localLock) {
      await localLock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
