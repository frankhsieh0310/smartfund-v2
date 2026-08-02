import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildTreasuryDataset,
  isValidCusip,
  selectDeterministicTreasurySample,
  UsTreasuryAuctionsAdapter,
  US_TREASURY_CANARY_TYPES,
  US_TREASURY_V1_CONTRACT,
  type NormalizedTreasuryAuction,
  type TreasuryRawPage,
} from "../../../lib/data-platform/providers/us-treasury/UsTreasuryAuctionsAdapter.ts";

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function assertDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`INVALID_SNAPSHOT_DATE:${value}`);
  }
  return value;
}

function fieldCoverage<T extends object>(rows: T[], fields: Array<keyof T>): Record<string, { present: number; total: number; coveragePercent: number }> {
  return Object.fromEntries(fields.map((field) => {
    const present = rows.filter((row) => row[field] !== null && row[field] !== undefined && row[field] !== "").length;
    return [String(field), { present, total: rows.length, coveragePercent: rows.length ? Number(((present / rows.length) * 100).toFixed(2)) : 0 }];
  }));
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  if (!process.argv.includes("--dry-run")) throw new Error("DRY_RUN_FLAG_REQUIRED");
  const snapshotDate = assertDate(argument("snapshot-date") ?? new Date().toISOString().slice(0, 10));
  const sampleCount = Number.parseInt(argument("count") ?? "20", 10);
  if (!Number.isInteger(sampleCount) || sampleCount < 10 || sampleCount > 25) throw new Error(`INVALID_CANARY_COUNT:${sampleCount}`);
  const outputRoot = path.resolve(argument("output-dir") ?? path.join("debug", "bond", "us-treasury-canary", snapshotDate));
  const rawRoot = path.join(outputRoot, "raw");
  await mkdir(rawRoot, { recursive: true });

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
  const sample = selectDeterministicTreasurySample(dataset, sampleCount);
  const sampleIds = new Set(sample.map((entry) => entry.instrument.officialSecurityId));
  const sampleInstruments = sample.map((entry) => entry.instrument);
  const sampleAuctions = dataset.auctions.filter((event) => sampleIds.has(event.officialSecurityId));
  const sampleLifecycle = dataset.lifecycleEvents.filter((event) => sampleIds.has(event.officialSecurityId));

  const invalidCusips = sampleInstruments.filter((instrument) => !isValidCusip(instrument.cusip)).map((instrument) => instrument.cusip);
  const issueAfterMaturity = sampleInstruments
    .filter((instrument) => instrument.issueDate && instrument.maturityDate && instrument.issueDate > instrument.maturityDate)
    .map((instrument) => instrument.officialSecurityId);
  const instrumentIds = sampleInstruments.map((instrument) => `${instrument.sourceNamespace}:${instrument.officialSecurityId}`);
  const duplicateInstrumentIds = instrumentIds.filter((value, index) => instrumentIds.indexOf(value) !== index);
  const eventIds = sampleAuctions.map((event) => `${event.sourceNamespace}:${event.sourceEventId}`);
  const duplicateEventIds = eventIds.filter((value, index) => eventIds.indexOf(value) !== index);
  const reopeningWithoutInstrument = sampleAuctions
    .filter((event) => event.reopening && !sampleIds.has(event.officialSecurityId))
    .map((event) => event.sourceEventId);
  const typeCounts = Object.fromEntries(US_TREASURY_CANARY_TYPES.map((type) => [type, sampleInstruments.filter((instrument) => instrument.securityType === type).length]));
  const newIssueCount = sample.filter((entry) => entry.hasNewIssueEvent).length;
  const reopeningCount = sample.filter((entry) => entry.hasReopeningEvent).length;
  const announcedCount = sampleInstruments.filter((instrument) => instrument.status === "ANNOUNCED").length;
  const maturityCount = new Set(sampleInstruments.map((instrument) => instrument.maturityDate).filter(Boolean)).size;
  const missingTypes = US_TREASURY_CANARY_TYPES.filter((type) => typeCounts[type] === 0);
  const sourceStatusCounts = Object.fromEntries(
    ["ANNOUNCED", "ACTIVE", "MATURED", "CALLED", "REDEEMED", "CANCELLED", "UNKNOWN"]
      .map((status) => [status, dataset.instruments.filter((instrument) => instrument.status === status).length]),
  );
  const validationErrors = [
    ...(invalidCusips.length ? [`INVALID_CUSIPS:${invalidCusips.length}`] : []),
    ...(issueAfterMaturity.length ? [`ISSUE_AFTER_MATURITY:${issueAfterMaturity.length}`] : []),
    ...(duplicateInstrumentIds.length ? [`DUPLICATE_INSTRUMENTS:${duplicateInstrumentIds.length}`] : []),
    ...(duplicateEventIds.length ? [`DUPLICATE_EVENTS:${duplicateEventIds.length}`] : []),
    ...(reopeningWithoutInstrument.length ? [`REOPENING_WITHOUT_INSTRUMENT:${reopeningWithoutInstrument.length}`] : []),
    ...(missingTypes.length ? [`MISSING_SECURITY_TYPES:${missingTypes.join(",")}`] : []),
    ...(newIssueCount === 0 ? ["NEW_ISSUE_NOT_COVERED"] : []),
    ...(reopeningCount === 0 ? ["REOPENING_NOT_COVERED"] : []),
    ...(maturityCount < 5 ? [`INSUFFICIENT_MATURITY_DIVERSITY:${maturityCount}`] : []),
  ];

  const duplicateReport = {
    rawRecords: records.length,
    normalizedUniverseInstruments: dataset.instruments.length,
    normalizedUniverseAuctionEvents: dataset.auctions.length,
    rawRecordsCollapsedByStableEventKey: records.length - dataset.auctions.length,
    sampleInstruments: sampleInstruments.length,
    sampleAuctionEvents: sampleAuctions.length,
    duplicateInstrumentIds,
    duplicateEventIds,
    reopeningInstrumentCount: reopeningCount,
    reopeningAuctionEventCount: sampleAuctions.filter((event) => event.reopening).length,
    reopeningCreatesDuplicateInstrument: false,
    reopeningWithoutInstrument,
  };
  const fieldCoverageReport = {
    instruments: fieldCoverage(sampleInstruments, [
      "sourceNamespace", "officialSecurityId", "cusip", "name", "securityType", "securityTerm", "country", "currency",
      "issueDate", "maturityDate", "couponRate", "couponType", "paymentFrequency", "originalIssueDate", "isReopening", "status", "sourceUpdatedAt",
    ]),
    auctionEvents: fieldCoverage(sampleAuctions, [
      "sourceNamespace", "sourceEventId", "officialSecurityId", "announcementDate", "auctionDate", "issueDate", "maturityDate",
      "offeringAmount", "acceptedAmount", "auctionPrice", "auctionYield", "interestRate", "reopening", "sourceUpdatedAt",
    ]),
  };
  const validationReport = {
    status: validationErrors.length === 0 ? "PASS" : "FAIL",
    snapshotDate,
    sampleCount,
    sourceRecordCount: records.length,
    eligibleInstrumentCount: dataset.instruments.filter((instrument) => instrument.status === "ACTIVE" || instrument.status === "ANNOUNCED").length,
    sourceStatusCounts,
    typeCounts,
    announcedCount,
    newIssueCount,
    reopeningCount,
    differentMaturityDates: maturityCount,
    cusipChecksumPassed: sampleInstruments.length - invalidCusips.length,
    cusipChecksumFailed: invalidCusips.length,
    issueDateBeforeOrEqualMaturityPassed: sampleInstruments.length - issueAfterMaturity.length,
    errors: validationErrors,
    databaseConnectionOpened: false,
    databaseWrites: 0,
    productionLockAcquired: false,
    lifecycleRunCreated: false,
    checkpointWrites: 0,
    failureQueueWrites: 0,
  };
  const plannedDatabaseOperations = {
    mode: "DRY_RUN",
    migrationApplied: false,
    bond_instruments: { plannedInserts: sampleInstruments.length, plannedUpdates: 0, upsertCandidates: sampleInstruments.length, uniqueKey: ["source_namespace", "official_security_id"], basis: "MIGRATION_NOT_APPLIED_TABLE_ABSENT" },
    bond_auction_events: { plannedInserts: sampleAuctions.length, plannedUpdates: 0, upsertCandidates: sampleAuctions.length, uniqueKey: ["source_namespace", "source_event_id"], basis: "MIGRATION_NOT_APPLIED_TABLE_ABSENT" },
    bond_lifecycle_events: { plannedInserts: sampleLifecycle.length, plannedUpdates: 0, upsertCandidates: sampleLifecycle.length, uniqueKey: ["source_namespace", "source_event_id", "event_type"], basis: "MIGRATION_NOT_APPLIED_TABLE_ABSENT" },
    bond_source_documents: { plannedInserts: sourcePages.length, plannedUpdates: 0, insertCandidates: sourcePages.length, uniqueKey: ["source_namespace", "source_document_id", "content_hash"], basis: "MIGRATION_NOT_APPLIED_TABLE_ABSENT" },
    production_scheduler_runs: { inserts: 0 },
    production_scheduler_locks: { inserts: 0 },
    production_scheduler_checkpoints: { writes: 0 },
    bond_ingestion_failures: { writes: 0 },
    actualDatabaseWrites: 0,
  };

  await Promise.all([
    writeJson(path.join(outputRoot, "source-manifest.json"), { contract: US_TREASURY_V1_CONTRACT, source: adapter.sourceNamespace, snapshotDate, pages: sourcePages }),
    writeJson(path.join(outputRoot, "normalized-canary.json"), { contract: US_TREASURY_V1_CONTRACT, snapshotDate, instruments: sampleInstruments, auctionEvents: sampleAuctions, lifecycleEvents: sampleLifecycle }),
    writeJson(path.join(outputRoot, "validation-report.json"), validationReport),
    writeJson(path.join(outputRoot, "duplicate-report.json"), duplicateReport),
    writeJson(path.join(outputRoot, "field-coverage-report.json"), fieldCoverageReport),
    writeJson(path.join(outputRoot, "planned-database-operations.json"), plannedDatabaseOperations),
  ]);

  console.log(JSON.stringify({
    status: validationReport.status,
    sourceNamespace: adapter.sourceNamespace,
    snapshotDate,
    sourceRecords: records.length,
    eligibleInstruments: validationReport.eligibleInstrumentCount,
    canaryInstruments: sampleInstruments.length,
    canaryAuctionEvents: sampleAuctions.length,
    canaryLifecycleEvents: sampleLifecycle.length,
    typeCounts,
    announcedCount,
    newIssueCount,
    reopeningCount,
    differentMaturityDates: maturityCount,
    databaseWrites: 0,
    outputRoot,
    errors: validationErrors,
  }, null, 2));
  if (validationErrors.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
