import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { DurableFileArchive, type DurableArchiveReplayResult, type DurableArchiveResult } from "../../../lib/data-platform/archive/DurableFileArchive.ts";
import {
  normalizeTaiwanGovernmentBond,
  TaiwanGovernmentBondAdapter,
  TAIWAN_GOVERNMENT_BOND_PARSER_VERSION,
  TAIWAN_GOVERNMENT_BOND_SOURCE_NAMESPACE,
  TAIWAN_GOVERNMENT_BOND_V1_CONTRACT,
  type NormalizedTaiwanGovernmentBond,
} from "../../../lib/data-platform/providers/taiwan-government-bond/TaiwanGovernmentBondAdapter.ts";
import { buildTaiwanGovernmentBondFreshnessLedger } from "../../../lib/data-platform/providers/taiwan-government-bond/TaiwanGovernmentBondFreshness.ts";
import { validateWorkerOwnershipFromEnvironment } from "../governance/worker-ownership.ts";

const INCREMENTAL_MODE = process.argv.includes("--incremental");
const JOB_ID = INCREMENTAL_MODE
  ? TAIWAN_GOVERNMENT_BOND_V1_CONTRACT.incrementalJobId
  : TAIWAN_GOVERNMENT_BOND_V1_CONTRACT.historicalJobId;
const EXCHANGE = "TAIWAN_GOVERNMENT_BOND";

type Checkpoint = {
  jobId: string;
  sampleHash: string;
  runId: string;
  lastOfficialSecurityId: string | null;
  processed: number;
  succeeded: number;
  failed: number;
  inserted: number;
  updated: number;
  noChange: number;
  completed: boolean;
  updatedAt: string;
};

type Failure = {
  jobId: string;
  officialSecurityId: string;
  stage: string;
  error: string;
  retryable: boolean;
  attempts: number;
  resolved: boolean;
  firstFailedAt: string;
  lastAttemptedAt: string;
};

type ExistingSecurity = {
  id: string;
  ticker: string | null;
  name: string;
  name_en: string | null;
  exchange: string | null;
  country: string | null;
  sector: string | null;
  industry: string | null;
  currency: string | null;
};

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function deterministicUuid(namespace: string, sourceId: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`${namespace}:${sourceId}`).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ticker(sourceId: string): string {
  return `TGB-${sourceId}`;
}

function assertSnapshotDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`INVALID_SNAPSHOT_DATE:${value}`);
  }
  return value;
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
  await handle.writeFile(`${JSON.stringify({ jobId: JOB_ID, runId, nodeId: process.env.SMARTFUND_NODE_ID, pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2)}\n`);
  return handle;
}

async function releaseLocalLock(handle: FileHandle | null, lockPath: string): Promise<void> {
  if (!handle) return;
  await handle.close();
  await unlink(lockPath).catch(() => undefined);
}

function matches(current: ExistingSecurity, row: NormalizedTaiwanGovernmentBond): boolean {
  return current.ticker === ticker(row.officialSecurityId)
    && current.name === row.name
    && current.name_en === row.name
    && current.exchange === EXCHANGE
    && current.country === row.country
    && current.sector === row.issuerName
    && current.industry === "Taiwan Government Bond"
    && current.currency === row.currency;
}

async function upsertSecurity(prisma: PrismaClient, row: NormalizedTaiwanGovernmentBond): Promise<"INSERTED" | "UPDATED" | "NO_CHANGE"> {
  const result = await prisma.$queryRawUnsafe<Array<{ inserted: boolean }>>(
    `INSERT INTO securities
      (id, ticker, isin, cusip, sedol, name, name_en, exchange, country, sector, industry, currency, created_at, updated_at)
     VALUES ($1, $2, NULL, NULL, NULL, $3, $3, $4, $5, $6, $7, $8, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       ticker = EXCLUDED.ticker,
       name = EXCLUDED.name,
       name_en = EXCLUDED.name_en,
       exchange = EXCLUDED.exchange,
       country = EXCLUDED.country,
       sector = EXCLUDED.sector,
       industry = EXCLUDED.industry,
       currency = EXCLUDED.currency,
       updated_at = NOW()
     WHERE securities.ticker IS DISTINCT FROM EXCLUDED.ticker
        OR securities.name IS DISTINCT FROM EXCLUDED.name
        OR securities.name_en IS DISTINCT FROM EXCLUDED.name_en
        OR securities.exchange IS DISTINCT FROM EXCLUDED.exchange
        OR securities.country IS DISTINCT FROM EXCLUDED.country
        OR securities.sector IS DISTINCT FROM EXCLUDED.sector
        OR securities.industry IS DISTINCT FROM EXCLUDED.industry
        OR securities.currency IS DISTINCT FROM EXCLUDED.currency
     RETURNING (xmax = 0) AS inserted`,
    deterministicUuid(row.sourceNamespace, row.officialSecurityId),
    ticker(row.officialSecurityId),
    row.name,
    EXCHANGE,
    row.country,
    row.issuerName,
    "Taiwan Government Bond",
    row.currency,
  );
  if (!result[0]) return "NO_CHANGE";
  return result[0].inserted ? "INSERTED" : "UPDATED";
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  if (dryRun === apply) throw new Error("EXACTLY_ONE_MODE_REQUIRED:--dry-run_OR_--apply");
  if (apply && !process.argv.includes("--confirm-production-write")) throw new Error("CONFIRM_PRODUCTION_WRITE_REQUIRED");
  if (apply && process.env.BOND_LIVE_WRITE_AUTHORIZED !== "true") throw new Error("BOND_LIVE_WRITE_AUTHORIZED_REQUIRED");
  const fullUniverse = process.argv.includes("--full-universe");
  const confirmFullUniverse = process.argv.includes("--confirm-full-universe");
  const count = Number.parseInt(argument("count") ?? "20", 10);
  const validCanary = Number.isInteger(count) && count >= 10 && count <= 25 && !fullUniverse;
  const validExpansion = count === 197 && fullUniverse && confirmFullUniverse;
  if (!validCanary && !validExpansion) throw new Error(`BOUNDED_SCOPE_NOT_AUTHORIZED:${count}:${fullUniverse}`);
  const verifyIdempotency = process.argv.includes("--verify-idempotency");
  const durableArchiveRequested = process.argv.includes("--durable-archive");
  const managedLifecycle = process.argv.includes("--managed-lifecycle");
  if (managedLifecycle && !INCREMENTAL_MODE) throw new Error("MANAGED_LIFECYCLE_INCREMENTAL_ONLY");
  if (managedLifecycle && !argument("run-id")) throw new Error("MANAGED_LIFECYCLE_RUN_ID_REQUIRED");
  if (INCREMENTAL_MODE && !validExpansion) throw new Error("INCREMENTAL_REQUIRES_CONFIRMED_FULL_UNIVERSE");
  if (apply && INCREMENTAL_MODE && process.env.RAILWAY_ENVIRONMENT_NAME && !durableArchiveRequested) {
    throw new Error("RAILWAY_INCREMENTAL_DURABLE_ARCHIVE_REQUIRED");
  }
  const snapshotDate = assertSnapshotDate(argument("snapshot-date") ?? new Date().toISOString().slice(0, 10));
  const ownership = await validateWorkerOwnershipFromEnvironment({
    domain: "BOND",
    market: TAIWAN_GOVERNMENT_BOND_V1_CONTRACT.market,
    mode: INCREMENTAL_MODE ? "INCREMENTAL" : "HISTORICAL",
    dryRun,
  });
  if (apply && !ownership.liveWriteAuthorized) throw new Error("OWNERSHIP_LIVE_WRITE_NOT_AUTHORIZED");

  const runId = argument("run-id") ?? randomUUID();
  const runtimeRoot = path.resolve(process.env.TAIWAN_BOND_RUNTIME_ROOT ?? path.join("runtime", "bond", "taiwan-government"));
  const outputRoot = dryRun
    ? path.resolve(argument("output-dir") ?? path.join("debug", "bond", "taiwan-government-importer", `${snapshotDate}-${runId}`))
    : path.join(runtimeRoot, "runs", runId);
  const scopeLabel = fullUniverse ? "full-universe" : `canary-${count}`;
  const checkpointPath = path.join(runtimeRoot, `${JOB_ID}-${scopeLabel}-checkpoint.json`);
  const failureQueuePath = path.join(runtimeRoot, `${JOB_ID}-failures.json`);
  const lockPath = path.join(runtimeRoot, `${JOB_ID}.lock.json`);
  await mkdir(path.join(outputRoot, "raw"), { recursive: true });

  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
  let lockHandle: FileHandle | null = null;
  try {
    const [activeLocks, activeRuns] = managedLifecycle ? [[], []] : await Promise.all([
      prisma.$queryRawUnsafe<Array<{ owner: string }>>(
        "SELECT owner FROM production_scheduler_locks WHERE job_id = $1 AND expires_at > NOW() AND updated_at > NOW() - INTERVAL '10 minutes'",
        JOB_ID,
      ),
      prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        "SELECT id, status FROM production_scheduler_runs WHERE job_id = $1 AND status IN ('RUNNING', 'IN_PROGRESS')",
        JOB_ID,
      ),
    ]);
    if (activeLocks.length) throw new Error(`ACTIVE_BOND_LOCK:${activeLocks[0].owner}`);
    if (activeRuns.length) throw new Error(`ACTIVE_BOND_LIFECYCLE:${activeRuns[0].id}:${activeRuns[0].status}`);
    if (apply) lockHandle = await acquireLocalLock(lockPath, runId);

    const adapter = new TaiwanGovernmentBondAdapter();
    const { document, bonds: rawBonds } = await adapter.fetch();
    const rawPath = path.join(outputRoot, "raw", `bond_ISSBD1_data-${document.contentHash.slice(0, 12)}.json`);
    await writeFile(rawPath, document.rawText, "utf8");
    const all = rawBonds
      .map((row) => normalizeTaiwanGovernmentBond(row, snapshotDate))
      .sort((left, right) => left.officialSecurityId.localeCompare(right.officialSecurityId));
    if (all.length !== 197) throw new Error(`TPEX_TW_BOND_UNIVERSE_DENOMINATOR_CHANGED:${all.length}:expected=197`);
    const duplicateIds = all.length - new Set(all.map((row) => row.officialSecurityId)).size;
    const invalidDates = all.filter((row) => row.issueDate > row.maturityDate).length;
    if (duplicateIds || invalidDates) throw new Error(`TPEX_TW_BOND_VALIDATION_FAILED:duplicate=${duplicateIds}:dates=${invalidDates}`);
    const selected = fullUniverse ? all : all.slice(0, count);
    const freshnessLedger = buildTaiwanGovernmentBondFreshnessLedger(selected, snapshotDate);
    const sampleHash = sha256(selected.map((row) => ({ id: row.officialSecurityId, hash: row.sourcePayloadHash })));
    const ids = selected.map((row) => deterministicUuid(row.sourceNamespace, row.officialSecurityId));
    const existing = await prisma.$queryRawUnsafe<ExistingSecurity[]>(
      `SELECT id, ticker, name, name_en, exchange, country, sector, industry, currency
       FROM securities WHERE id = ANY($1::text[])`,
      ids,
    );
    const existingById = new Map(existing.map((row) => [row.id, row]));
    for (const row of selected) {
      const current = existingById.get(deterministicUuid(row.sourceNamespace, row.officialSecurityId));
      if (current && current.exchange !== EXCHANGE) throw new Error(`SECURITY_ID_COLLISION:${row.officialSecurityId}:${current.exchange}`);
    }

    let prior = verifyIdempotency ? null : await readJson<Checkpoint | null>(checkpointPath, null);
    if (prior?.completed) prior = null;
    if (prior && prior.sampleHash !== sampleHash) throw new Error("CHECKPOINT_SAMPLE_HASH_MISMATCH");
    const resumeIndex = prior?.lastOfficialSecurityId
      ? selected.findIndex((row) => row.officialSecurityId === prior!.lastOfficialSecurityId)
      : -1;
    if (prior?.lastOfficialSecurityId && resumeIndex < 0) throw new Error(`CHECKPOINT_ID_NOT_FOUND:${prior.lastOfficialSecurityId}`);
    const remaining = verifyIdempotency ? selected : selected.slice(resumeIndex + 1);
    const checkpoint: Checkpoint = prior
      ? { ...prior, runId }
      : {
          jobId: JOB_ID,
          sampleHash,
          runId,
          lastOfficialSecurityId: null,
          processed: 0,
          succeeded: 0,
          failed: 0,
          inserted: 0,
          updated: 0,
          noChange: 0,
          completed: false,
          updatedAt: new Date().toISOString(),
        };
    const failureQueue = await readJson<Failure[]>(failureQueuePath, []);

    for (const row of remaining) {
      checkpoint.processed += 1;
      try {
        const current = existingById.get(deterministicUuid(row.sourceNamespace, row.officialSecurityId));
        const outcome = dryRun
          ? current && matches(current, row) ? "NO_CHANGE" : current ? "UPDATED" : "INSERTED"
          : current && matches(current, row) ? "NO_CHANGE" : await upsertSecurity(prisma, row);
        if (outcome === "INSERTED") checkpoint.inserted += 1;
        else if (outcome === "UPDATED") checkpoint.updated += 1;
        else checkpoint.noChange += 1;
        checkpoint.succeeded += 1;
        if (apply) {
          for (const failure of failureQueue) {
            if (failure.officialSecurityId === row.officialSecurityId && !failure.resolved) {
              failure.resolved = true;
              failure.lastAttemptedAt = new Date().toISOString();
            }
          }
        }
      } catch (error) {
        checkpoint.failed += 1;
        const now = new Date().toISOString();
        const existingFailure = failureQueue.find((item) => item.officialSecurityId === row.officialSecurityId && item.stage === "CANONICAL_SECURITY_UPSERT");
        const failure: Failure = {
          jobId: JOB_ID,
          officialSecurityId: row.officialSecurityId,
          stage: "CANONICAL_SECURITY_UPSERT",
          error: error instanceof Error ? error.message : String(error),
          retryable: true,
          attempts: (existingFailure?.attempts ?? 0) + 1,
          resolved: false,
          firstFailedAt: existingFailure?.firstFailedAt ?? now,
          lastAttemptedAt: now,
        };
        if (existingFailure) Object.assign(existingFailure, failure);
        else failureQueue.push(failure);
      }
      checkpoint.lastOfficialSecurityId = row.officialSecurityId;
      checkpoint.updatedAt = new Date().toISOString();
      if (apply) {
        await writeJson(checkpointPath, checkpoint);
        await writeJson(failureQueuePath, failureQueue);
      }
    }
    checkpoint.completed = checkpoint.processed === selected.length;
    checkpoint.updatedAt = new Date().toISOString();
    if (apply) await writeJson(checkpointPath, checkpoint);

    const normalizedPath = path.join(outputRoot, "normalized-bonds.json");
    const freshnessPath = path.join(outputRoot, "freshness-ledger.json");
    const sourceManifestPath = path.join(outputRoot, "source-manifest.json");
    await writeJson(normalizedPath, selected);
    await writeJson(freshnessPath, freshnessLedger);
    await writeJson(sourceManifestPath, {
      ...document,
      rawText: undefined,
      parserVersion: TAIWAN_GOVERNMENT_BOND_PARSER_VERSION,
    });
    let archive: DurableArchiveResult | null = null;
    let replay: DurableArchiveReplayResult | null = null;
    if (durableArchiveRequested) {
      const durable = new DurableFileArchive({
        root: process.env.BOND_ARCHIVE_ROOT ?? path.join(runtimeRoot, "durable-archive"),
        prefix: process.env.TAIWAN_BOND_ARCHIVE_PREFIX ?? "taiwan-government/v1",
      });
      archive = await durable.archiveRun({
        runId,
        sourceNamespace: TAIWAN_GOVERNMENT_BOND_SOURCE_NAMESPACE,
        parserVersion: TAIWAN_GOVERNMENT_BOND_PARSER_VERSION,
        files: [
          { localPath: rawPath, logicalPath: "latest/raw/bond_ISSBD1_data.json", contentType: "application/json", sourceDocumentId: document.sourceDocumentId, sourceUpdatedAt: document.sourceDate, fetchedAt: document.fetchedAt },
          { localPath: normalizedPath, logicalPath: `runs/${runId}/normalized-bonds.json`, contentType: "application/json", sourceDocumentId: document.sourceDocumentId, sourceUpdatedAt: document.sourceDate, fetchedAt: document.fetchedAt },
          { localPath: freshnessPath, logicalPath: "latest/freshness-ledger.json", contentType: "application/json", sourceDocumentId: document.sourceDocumentId, sourceUpdatedAt: document.sourceDate, fetchedAt: document.fetchedAt },
          { localPath: sourceManifestPath, logicalPath: "latest/source-manifest.json", contentType: "application/json", sourceDocumentId: document.sourceDocumentId, sourceUpdatedAt: document.sourceDate, fetchedAt: document.fetchedAt },
        ],
      });
      replay = await durable.restoreAndReplay(archive.manifestPath);
    }

    const coverage = {
      universe: { numerator: all.length, denominator: all.length, percent: 100 },
      identity: { numerator: all.filter((row) => row.officialSecurityId).length, denominator: all.length },
      issueDate: { numerator: all.filter((row) => row.issueDate).length, denominator: all.length },
      maturityDate: { numerator: all.filter((row) => row.maturityDate).length, denominator: all.length },
      coupon: { numerator: all.filter((row) => row.couponRate).length, denominator: all.length },
      outstandingAmount: { numerator: all.filter((row) => row.outstandingAmount).length, denominator: all.length },
      active: all.filter((row) => row.status === "ACTIVE").length,
      announced: all.filter((row) => row.status === "ANNOUNCED").length,
      matured: all.filter((row) => row.status === "MATURED").length,
    };
    const result = {
      status: checkpoint.failed === 0 ? "PASS" : "COMPLETE_WITH_EXCEPTIONS",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      jobId: JOB_ID,
      runId,
      ownership,
      source: {
        endpoint: document.requestUrl,
        sourceDocumentId: document.sourceDocumentId,
        sourceDate: document.sourceDate,
        fetchedAt: document.fetchedAt,
        rawPayloadHash: document.contentHash,
      },
      universeDenominator: all.length,
      selected: selected.length,
      checkpoint,
      coverage,
      failureQueue: {
        total: failureQueue.length,
        open: failureQueue.filter((item) => !item.resolved).length,
        retryable: failureQueue.filter((item) => !item.resolved && item.retryable).length,
      },
      freshness: {
        records: freshnessLedger.length,
        denominator: selected.length * 6,
        measurable: freshnessLedger.filter((row) => row.expectedUpdateDate && row.freshnessReason && row.validatorVersion).length,
        freshOfficialSnapshots: freshnessLedger.filter((row) => row.layer === "LATEST_OFFICIAL_SNAPSHOT" && row.freshnessStatus === "FRESH").length,
        secondaryMarketUnknown: freshnessLedger.filter((row) => row.layer === "SECONDARY_MARKET_PRICE" && row.freshnessStatus === "UNKNOWN").length,
        artifact: freshnessPath,
      },
      databaseWrites: dryRun ? 0 : checkpoint.inserted + checkpoint.updated,
      writesTable: dryRun ? [] : ["securities"],
      crossDomainWrites: 0,
      archive,
      archiveReplay: replay,
      schemaGaps: ["bond_details", "bond_market_observations", "bond_source_documents"],
      nextAction: selected.length < all.length
        ? "EXPAND_TO_FULL_197"
        : INCREMENTAL_MODE
          ? "PRODUCTION_MAINTENANCE"
          : "BUILD_INCREMENTAL_AND_PRODUCTION_SCHEDULER",
    };
    await writeJson(path.join(outputRoot, "result.json"), result);
    console.log(JSON.stringify(result, null, 2));
    if (checkpoint.failed > 0) process.exitCode = 2;
  } finally {
    await releaseLocalLock(lockHandle, lockPath);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
