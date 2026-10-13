import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  buildTreasuryDataset,
  isValidCusip,
  selectDeterministicTreasurySample,
  selectFullEligibleTreasuryUniverse,
  UsTreasuryAuctionsAdapter,
  US_TREASURY_SOURCE_NAMESPACE,
  US_TREASURY_V1_CONTRACT,
  type NormalizedTreasuryAuction,
  type NormalizedTreasuryInstrument,
  type TreasuryRawPage,
} from "../../../lib/data-platform/providers/us-treasury/UsTreasuryAuctionsAdapter.ts";
import { validateWorkerOwnershipFromEnvironment } from "../governance/worker-ownership.ts";

const INCREMENTAL_MODE = process.argv.includes("--incremental");
const JOB_ID = INCREMENTAL_MODE
  ? US_TREASURY_V1_CONTRACT.incrementalJobId
  : US_TREASURY_V1_CONTRACT.historicalJobId;
const ISSUER = "United States Department of the Treasury";
const EXCHANGE = "US_TREASURY";

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
  sourceNamespace: string;
  officialSecurityId: string;
  stage: string;
  error: string;
  attempts: number;
  retryable: boolean;
  firstFailedAt: string;
  lastAttemptedAt: string;
  resolved: boolean;
};

type CanonicalPreview = {
  id: string;
  source: string;
  sourceId: string;
  cusip: string;
  isin: null;
  issuer: string;
  name: string;
  country: "US";
  currency: "USD";
  bondType: string;
  issueDate: string | null;
  maturityDate: string | null;
  couponRate: string | null;
  couponType: string;
  faceValue: null;
  latestAuctionPrice: string | null;
  latestAuctionYield: string | null;
  latestDate: string | null;
  rawPayloadHash: string;
  importedAt: string;
};

type ExistingSecurity = {
  id: string;
  ticker: string;
  cusip: string | null;
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

function assertDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) throw new Error(`INVALID_DATE:${value}`);
  return value;
}

function deterministicUuid(namespace: string, sourceId: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`${namespace}:${sourceId}`).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function internalTicker(row: CanonicalPreview): string {
  return `UST-${createHash("sha256").update(`${row.source}:${row.sourceId}`).digest("hex").slice(0, 12).toUpperCase()}`;
}

function matchesCanonicalSecurity(current: ExistingSecurity, row: CanonicalPreview): boolean {
  return current.ticker === internalTicker(row)
    && current.cusip === row.cusip
    && current.name === row.name
    && current.name_en === row.name
    && current.exchange === EXCHANGE
    && current.country === row.country
    && current.sector === row.issuer
    && current.industry === `${row.bondType} Sovereign Government Bond`
    && current.currency === row.currency;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(filePath, "utf8")) as T; } catch (error) {
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
  await handle.writeFile(`${JSON.stringify({ jobId: JOB_ID, runId, owner: process.env.SMARTFUND_NODE_ID, pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2)}\n`);
  return handle;
}

async function releaseLocalLock(handle: FileHandle | null, lockPath: string): Promise<void> {
  if (!handle) return;
  await handle.close();
  await unlink(lockPath).catch(() => undefined);
}

function latestAuction(events: NormalizedTreasuryAuction[]): NormalizedTreasuryAuction | null {
  return [...events].sort((left, right) => `${right.sourceUpdatedAt ?? ""}:${right.auctionDate}`.localeCompare(`${left.sourceUpdatedAt ?? ""}:${left.auctionDate}`))[0] ?? null;
}

function preview(instrument: NormalizedTreasuryInstrument, events: NormalizedTreasuryAuction[], importedAt: string): CanonicalPreview {
  const latest = latestAuction(events);
  return {
    id: deterministicUuid(instrument.sourceNamespace, instrument.officialSecurityId),
    source: instrument.sourceNamespace,
    sourceId: instrument.officialSecurityId,
    cusip: instrument.cusip,
    isin: null,
    issuer: ISSUER,
    name: instrument.name,
    country: "US",
    currency: "USD",
    bondType: instrument.securityType,
    issueDate: instrument.issueDate,
    maturityDate: instrument.maturityDate,
    couponRate: instrument.couponRate,
    couponType: instrument.couponType,
    faceValue: null,
    latestAuctionPrice: latest?.auctionPrice ?? null,
    latestAuctionYield: latest?.auctionYield ?? null,
    latestDate: latest?.sourceUpdatedAt ?? latest?.auctionDate ?? null,
    rawPayloadHash: hash(events),
    importedAt,
  };
}

async function upsertSecurity(prisma: PrismaClient, row: CanonicalPreview): Promise<"INSERTED" | "UPDATED" | "NO_CHANGE"> {
  const ticker = internalTicker(row);
  const result = await prisma.$queryRawUnsafe<Array<{ inserted: boolean }>>(
    `INSERT INTO securities
      (id, ticker, isin, cusip, sedol, name, name_en, exchange, country, sector, industry, currency, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, NULL, $4, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       ticker = EXCLUDED.ticker,
       cusip = EXCLUDED.cusip,
       name = EXCLUDED.name,
       name_en = EXCLUDED.name_en,
       exchange = EXCLUDED.exchange,
       country = EXCLUDED.country,
       sector = EXCLUDED.sector,
       industry = EXCLUDED.industry,
       currency = EXCLUDED.currency,
       updated_at = NOW()
     WHERE securities.ticker IS DISTINCT FROM EXCLUDED.ticker
        OR securities.cusip IS DISTINCT FROM EXCLUDED.cusip
        OR securities.name IS DISTINCT FROM EXCLUDED.name
        OR securities.name_en IS DISTINCT FROM EXCLUDED.name_en
        OR securities.exchange IS DISTINCT FROM EXCLUDED.exchange
        OR securities.country IS DISTINCT FROM EXCLUDED.country
        OR securities.sector IS DISTINCT FROM EXCLUDED.sector
        OR securities.industry IS DISTINCT FROM EXCLUDED.industry
        OR securities.currency IS DISTINCT FROM EXCLUDED.currency
     RETURNING (xmax = 0) AS inserted`,
    row.id,
    ticker,
    row.cusip,
    row.name,
    EXCHANGE,
    row.country,
    row.issuer,
    `${row.bondType} Sovereign Government Bond`,
    row.currency,
  );
  if (!result[0]) return "NO_CHANGE";
  return result[0].inserted ? "INSERTED" : "UPDATED";
}

async function saveFailure(filePath: string, failure: Failure): Promise<void> {
  const queue = await readJson<Failure[]>(filePath, []);
  const index = queue.findIndex((item) => item.jobId === failure.jobId && item.sourceNamespace === failure.sourceNamespace && item.officialSecurityId === failure.officialSecurityId && item.stage === failure.stage);
  if (index >= 0) queue[index] = { ...failure, attempts: queue[index].attempts + 1, firstFailedAt: queue[index].firstFailedAt };
  else queue.push(failure);
  await writeJson(filePath, queue);
}

async function resolveFailure(filePath: string, officialSecurityId: string): Promise<void> {
  const queue = await readJson<Failure[]>(filePath, []);
  let changed = false;
  for (const failure of queue) {
    if (failure.jobId === JOB_ID && failure.officialSecurityId === officialSecurityId && !failure.resolved) {
      failure.resolved = true;
      failure.lastAttemptedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) await writeJson(filePath, queue);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  if (dryRun === apply) throw new Error("EXACTLY_ONE_MODE_REQUIRED:--dry-run_OR_--apply");
  if (apply && !process.argv.includes("--confirm-production-write")) throw new Error("CONFIRM_PRODUCTION_WRITE_REQUIRED");
  if (apply && process.env.BOND_LIVE_WRITE_AUTHORIZED !== "true") throw new Error("BOND_LIVE_WRITE_AUTHORIZED_REQUIRED");
  const verifyIdempotency = process.argv.includes("--verify-idempotency");
  const expectSimulatedFailure = process.argv.includes("--expect-simulated-failure");
  const injectFailureAt = Number.parseInt(argument("inject-failure-at") ?? "0", 10);
  if (injectFailureAt > 0 && !dryRun) throw new Error("SIMULATED_FAILURE_DRY_RUN_ONLY");
  const count = Number.parseInt(argument("count") ?? "20", 10);
  const batchExpansion = process.argv.includes("--confirm-batch-expansion");
  const fullUniverse = process.argv.includes("--full-universe");
  const confirmFullUniverse = process.argv.includes("--confirm-full-universe");
  const validCanary = Number.isInteger(count) && count >= 10 && count <= 25;
  const validExpansion = Number.isInteger(count) && count === 250 && batchExpansion;
  const validFullUniverse = fullUniverse && confirmFullUniverse && argument("count") === undefined;
  if (!validCanary && !validExpansion && !validFullUniverse) throw new Error(`BOUNDED_SCOPE_NOT_AUTHORIZED:count=${count}:fullUniverse=${fullUniverse}`);
  if (INCREMENTAL_MODE && !validFullUniverse) throw new Error("INCREMENTAL_REQUIRES_CONFIRMED_FULL_UNIVERSE");
  const snapshotDate = assertDate(argument("snapshot-date") ?? new Date().toISOString().slice(0, 10));
  const ownershipMode = INCREMENTAL_MODE ? "INCREMENTAL" : "HISTORICAL";
  const ownership = await validateWorkerOwnershipFromEnvironment({ domain: "BOND", market: "US_TREASURY", mode: ownershipMode, dryRun });
  if (apply && !ownership.liveWriteAuthorized) throw new Error("OWNERSHIP_LIVE_WRITE_NOT_AUTHORIZED");

  const runId = randomUUID();
  const runtimeRoot = path.resolve("runtime", "bond", "us-treasury");
  const scopeLabel = INCREMENTAL_MODE ? "incremental" : fullUniverse ? "full-universe" : count <= 25 ? "canary" : `batch-${count}`;
  const outputRoot = dryRun
    ? path.resolve(argument("output-dir") ?? path.join("debug", "bond", "us-treasury-importer", `${snapshotDate}-${runId}`))
    : path.join(runtimeRoot, "runs", runId);
  const checkpointPath = path.join(runtimeRoot, `${JOB_ID}-${scopeLabel}-checkpoint.json`);
  const failureQueuePath = path.join(runtimeRoot, `${JOB_ID}-failures.json`);
  const lockPath = path.join(runtimeRoot, `${JOB_ID}.lock.json`);
  await mkdir(path.join(outputRoot, "raw"), { recursive: true });

  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
  let lockHandle: FileHandle | null = null;
  let databaseWrites = 0;
  try {
    const [activeLocks, activeRuns] = await Promise.all([
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
    if (apply) {
      lockHandle = await acquireLocalLock(lockPath, runId);
      await writeJson(failureQueuePath, await readJson<Failure[]>(failureQueuePath, []));
    }

    const sourcePages: Array<Omit<TreasuryRawPage, "rawText"> & { storagePath: string }> = [];
    const adapter = new UsTreasuryAuctionsAdapter();
    const records = await adapter.fetchAuctions({
      filters: [`maturity_date:gte:${snapshotDate}`],
      pageSize: 250,
      onPage: async (page) => {
        const relativePath = path.join("raw", `page-${String(page.pageNumber).padStart(4, "0")}-${page.contentHash.slice(0, 12)}.json`);
        await writeFile(path.join(outputRoot, relativePath), page.rawText, "utf8");
        const { rawText: _rawText, ...metadata } = page;
        sourcePages.push({ ...metadata, storagePath: relativePath.replaceAll("\\", "/") });
      },
    });
    const dataset = buildTreasuryDataset(records, snapshotDate);
    const sample = fullUniverse
      ? selectFullEligibleTreasuryUniverse(dataset)
      : selectDeterministicTreasurySample(dataset, count);
    const selectedSourceIds = new Set(sample.map(({ instrument }) => instrument.officialSecurityId));
    const normalizedInstruments = sample.map(({ instrument }) => instrument);
    const normalizedAuctions = dataset.auctions.filter((event) => selectedSourceIds.has(event.officialSecurityId));
    const normalizedLifecycleEvents = dataset.lifecycleEvents.filter((event) => selectedSourceIds.has(event.officialSecurityId));
    const importedAt = new Date().toISOString();
    const rows = sample.map(({ instrument, auctions }) => preview(instrument, auctions, importedAt));
    const sampleHash = hash(rows.map((row) => ({ source: row.source, sourceId: row.sourceId, rawPayloadHash: row.rawPayloadHash })));
    const invalidCusips = rows.filter((row) => !isValidCusip(row.cusip));
    const invalidDates = rows.filter((row) => row.issueDate && row.maturityDate && row.issueDate > row.maturityDate);
    const duplicateIds = rows.map((row) => row.id).filter((id, index, values) => values.indexOf(id) !== index);
    const duplicateSourceIds = rows.map((row) => row.sourceId).filter((id, index, values) => values.indexOf(id) !== index);
    if (invalidCusips.length || invalidDates.length || duplicateIds.length || duplicateSourceIds.length) {
      throw new Error(`CANARY_VALIDATION_FAILED:cusip=${invalidCusips.length}:dates=${invalidDates.length}:ids=${duplicateIds.length}:sourceIds=${duplicateSourceIds.length}`);
    }
    const existing = await prisma.$queryRawUnsafe<ExistingSecurity[]>(
      `SELECT id, ticker, cusip, name, name_en, exchange, country, sector, industry, currency
       FROM securities
       WHERE id = ANY($1::text[])`,
      rows.map((row) => row.id),
    );
    const existingById = new Map(existing.map((row) => [row.id, row]));
    for (const current of existing) {
      const expected = rows.find((row) => row.id === current.id)!;
      if (current.cusip !== expected.cusip || current.exchange !== EXCHANGE) throw new Error(`SECURITY_ID_COLLISION:${current.id}`);
    }

    let priorCheckpoint = verifyIdempotency || dryRun ? null : await readJson<Checkpoint | null>(checkpointPath, null);
    if (INCREMENTAL_MODE && priorCheckpoint?.completed) priorCheckpoint = null;
    if (priorCheckpoint && priorCheckpoint.sampleHash !== sampleHash) throw new Error("CHECKPOINT_SAMPLE_HASH_MISMATCH");
    const resumeIndex = priorCheckpoint?.lastOfficialSecurityId
      ? rows.findIndex((row) => row.sourceId === priorCheckpoint.lastOfficialSecurityId)
      : -1;
    if (priorCheckpoint?.lastOfficialSecurityId && resumeIndex < 0) throw new Error(`CHECKPOINT_ID_NOT_FOUND:${priorCheckpoint.lastOfficialSecurityId}`);
    const remaining = verifyIdempotency ? rows : rows.slice(resumeIndex + 1);
    const checkpoint: Checkpoint = verifyIdempotency || !priorCheckpoint
      ? { jobId: JOB_ID, sampleHash, runId, lastOfficialSecurityId: null, processed: 0, succeeded: 0, failed: 0, inserted: 0, updated: 0, noChange: 0, completed: false, updatedAt: importedAt }
      : { ...priorCheckpoint, runId };
    const dryRunFailures: Failure[] = [];

    for (let index = 0; index < remaining.length; index += 1) {
      const row = remaining[index];
      checkpoint.processed += 1;
      try {
        if (injectFailureAt === index + 1) throw new Error("SIMULATED_SINGLE_INSTRUMENT_FAILURE");
        if (apply) {
          const current = existingById.get(row.id);
          const outcome = current && matchesCanonicalSecurity(current, row)
            ? "NO_CHANGE"
            : await upsertSecurity(prisma, row);
          databaseWrites += outcome === "NO_CHANGE" ? 0 : 1;
          if (outcome === "INSERTED") checkpoint.inserted += 1;
          else if (outcome === "UPDATED") checkpoint.updated += 1;
          else checkpoint.noChange += 1;
          await resolveFailure(failureQueuePath, row.sourceId);
        }
        checkpoint.succeeded += 1;
      } catch (error) {
        checkpoint.failed += 1;
        const now = new Date().toISOString();
        const failure: Failure = {
          jobId: JOB_ID,
          sourceNamespace: US_TREASURY_SOURCE_NAMESPACE,
          officialSecurityId: row.sourceId,
          stage: "CANONICAL_SECURITY_UPSERT",
          error: error instanceof Error ? error.message : String(error),
          attempts: 1,
          retryable: true,
          firstFailedAt: now,
          lastAttemptedAt: now,
          resolved: false,
        };
        if (apply) await saveFailure(failureQueuePath, failure);
        else dryRunFailures.push(failure);
      }
      checkpoint.lastOfficialSecurityId = row.sourceId;
      checkpoint.updatedAt = new Date().toISOString();
      if (apply) await writeJson(checkpointPath, checkpoint);
      if (apply && (checkpoint.processed % 100 === 0 || index === remaining.length - 1)) {
        const identifierCount = rows.filter((candidate) => isValidCusip(candidate.cusip)).length;
        const termsCount = rows.filter((candidate) => candidate.issueDate && candidate.maturityDate && (candidate.couponRate || candidate.couponType === "ZERO_COUPON")).length;
        const historicalCount = sample.filter((candidate) => candidate.auctions.length > 0).length;
        const latestCount = rows.filter((candidate) => candidate.latestDate !== null).length;
        console.log(JSON.stringify({
          event: "BOND_V1_PROGRESS",
          WORKER_ID: process.env.SMARTFUND_NODE_ID ?? "UNKNOWN",
          ASSIGNMENT: `BOND/US_TREASURY/${ownershipMode}`,
          BOND_V1_SCOPE: scopeLabel,
          SOURCE: US_TREASURY_SOURCE_NAMESPACE,
          STATUS: checkpoint.failed === 0 ? "RUNNING" : "RUNNING_WITH_FAILURES",
          CURRENT_LAYER: "UNIVERSE+TERMS+AUCTION_HISTORY+LATEST_OFFICIAL_AUCTION",
          START_TIME: importedAt,
          ELAPSED_TIME_MS: Date.now() - Date.parse(importedAt),
          UNIVERSE: rows.length,
          ATTEMPTED: checkpoint.processed,
          SUCCEEDED: checkpoint.succeeded,
          FAILED: checkpoint.failed,
          RETRYABLE: checkpoint.failed,
          NON_RETRYABLE: 0,
          CURRENT_SECURITY: row.sourceId,
          CHECKPOINT: checkpointPath,
          ROWS_INSERTED: checkpoint.inserted,
          ROWS_UPDATED: checkpoint.updated,
          ROWS_UNCHANGED: checkpoint.noChange,
          RAW_FILES_ARCHIVED: sourcePages.length,
          IDENTIFIER_COVERAGE: `${identifierCount}/${rows.length}`,
          TERMS_COVERAGE: `${termsCount}/${rows.length}`,
          HISTORICAL_COVERAGE: `${historicalCount}/${rows.length}`,
          LATEST_COVERAGE: `${latestCount}/${rows.length}`,
          FRESHNESS_COVERAGE: "NOT_MEASURABLE",
          ACTIVE_LOCK: true,
          ERROR_SUMMARY: checkpoint.failed === 0 ? null : `${checkpoint.failed} item failures queued`,
          NEXT_ACTION: checkpoint.processed === rows.length ? "VALIDATE_AND_IDEMPOTENCY_CHECK" : "CONTINUE_CURRENT_UNIVERSE",
          CONTINUING: checkpoint.processed < rows.length ? "YES" : "NO",
        }));
      }
    }
    checkpoint.completed = checkpoint.processed === rows.length || verifyIdempotency;
    checkpoint.updatedAt = new Date().toISOString();
    if (apply) await writeJson(checkpointPath, checkpoint);

    const databaseRows = apply
      ? await prisma.$queryRawUnsafe<Array<{ rows: number; distinct_ids: number; distinct_cusips: number }>>(
          "SELECT COUNT(*)::int AS rows, COUNT(DISTINCT id)::int AS distinct_ids, COUNT(DISTINCT cusip)::int AS distinct_cusips FROM securities WHERE id = ANY($1::text[])",
          rows.map((row) => row.id),
        )
      : [{ rows: existing.length, distinct_ids: existing.length, distinct_cusips: new Set(existing.map((row) => row.cusip)).size }];
    const unresolvedFailures = apply
      ? (await readJson<Failure[]>(failureQueuePath, [])).filter((failure) => !failure.resolved).length
      : dryRunFailures.length;
    const expectedFailurePassed = expectSimulatedFailure && checkpoint.failed === 1 && checkpoint.processed === rows.length && checkpoint.succeeded === rows.length - 1;
    const status = expectSimulatedFailure
      ? expectedFailurePassed ? "PASS_EXPECTED_SINGLE_FAILURE_NONBLOCKING" : "FAIL"
      : checkpoint.failed === 0 ? "PASS" : "PASS_WITH_FAILURES";
    const report = {
      status,
      mode: dryRun
        ? INCREMENTAL_MODE ? "DRY_RUN_INCREMENTAL" : "DRY_RUN"
        : verifyIdempotency
          ? "APPLY_IDEMPOTENCY_VERIFICATION"
          : INCREMENTAL_MODE
            ? "APPLY_INCREMENTAL"
            : fullUniverse ? "APPLY_FULL_UNIVERSE" : "APPLY_CANARY",
      ownership,
      contract: US_TREASURY_V1_CONTRACT,
      snapshotDate,
      runId,
      sourceRecords: records.length,
      eligibleUniverse: dataset.instruments.filter((instrument) => instrument.status === "ACTIVE" || instrument.status === "ANNOUNCED").length,
      selectedUniverse: rows.length,
      canary: fullUniverse ? null : rows.length,
      processed: checkpoint.processed,
      succeeded: checkpoint.succeeded,
      failed: checkpoint.failed,
      inserted: checkpoint.inserted,
      updated: checkpoint.updated,
      noChange: checkpoint.noChange,
      databaseWrites,
      databaseRows: databaseRows[0],
      rawArchiveDocuments: sourcePages.length,
      normalizedRows: rows.length,
      historicalAuctionEventsInArchive: normalizedAuctions.length,
      lifecycleEventsInArchive: normalizedLifecycleEvents.length,
      latestAvailableDate: rows.map((row) => row.latestDate).filter((value): value is string => value !== null).sort().at(-1) ?? null,
      checkpoint: dryRun ? null : checkpointPath,
      failureQueue: dryRun ? dryRunFailures : failureQueuePath,
      unresolvedFailures,
      idempotent: verifyIdempotency ? checkpoint.inserted === 0 && checkpoint.updated === 0 && databaseRows[0]?.rows === rows.length : null,
      schemaGaps: ["issuer_structured", "issue_date", "maturity_date", "coupon_rate", "coupon_type", "face_value", "auction_events", "latest_auction_metrics", "raw_payload_hash", "source_id"],
      writesTable: apply ? "securities" : null,
      crossDomainWrites: 0,
    };
    await Promise.all([
      writeJson(path.join(outputRoot, "source-manifest.json"), { sourceNamespace: US_TREASURY_SOURCE_NAMESPACE, pages: sourcePages }),
      writeJson(path.join(outputRoot, "normalized-preview.json"), rows),
      writeJson(path.join(outputRoot, "normalized-instruments.json"), normalizedInstruments),
      writeJson(path.join(outputRoot, "normalized-auction-history.json"), normalizedAuctions),
      writeJson(path.join(outputRoot, "normalized-lifecycle-events.json"), normalizedLifecycleEvents),
      writeJson(path.join(outputRoot, "import-report.json"), report),
    ]);
    console.log(JSON.stringify({ ...report, outputRoot }, null, 2));
    if (status === "FAIL") process.exitCode = 1;
  } finally {
    await releaseLocalLock(lockHandle, lockPath);
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
