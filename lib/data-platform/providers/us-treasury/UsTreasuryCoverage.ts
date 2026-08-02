import type { NormalizedTreasuryDataset } from "./UsTreasuryAuctionsAdapter.ts";
import type { TreasuryFreshnessLedger, TreasuryTermsCoverage } from "./UsTreasuryFreshness.ts";

export type BondCoverageStatus = "COMPLETED" | "PARTIAL" | "BLOCKED" | "NOT_STARTED" | "NOT_APPLICABLE";

export type BondCoverageLayer = {
  layer: string;
  status: BondCoverageStatus;
  denominator: number;
  numerator: number;
  coveragePercent: number;
  remaining: number;
  blocker: string | null;
  owner: string;
  nextAction: string;
};

export type BondCoverageMatrix = {
  version: 1;
  asset: "BOND";
  market: "US_TREASURY";
  generatedAt: string;
  snapshotDate: string;
  layers: BondCoverageLayer[];
  remainingLayers: number;
  completedLayers: number;
};

function layer(input: Omit<BondCoverageLayer, "coveragePercent" | "remaining">): BondCoverageLayer {
  const denominator = Math.max(0, input.denominator);
  const numerator = Math.min(Math.max(0, input.numerator), denominator);
  return {
    ...input,
    denominator,
    numerator,
    coveragePercent: denominator === 0
      ? input.status === "NOT_APPLICABLE" ? 100 : 0
      : Number((numerator / denominator * 100).toFixed(3)),
    remaining: Math.max(0, denominator - numerator),
  };
}

export function buildUsTreasuryCoverageMatrix(input: {
  dataset: NormalizedTreasuryDataset;
  terms: TreasuryTermsCoverage;
  freshness: TreasuryFreshnessLedger;
  snapshotDate: string;
  archiveCompleted: boolean;
  schedulerOnline: boolean;
  productionLiveRunPassed: boolean;
  failureQueueOperational: boolean;
  retryOperational: boolean;
  lineageCompleted: boolean;
}): BondCoverageMatrix {
  const denominator = input.dataset.instruments.length;
  const validCusips = input.dataset.instruments.filter((value) => /^[0-9A-Z*@#]{9}$/.test(value.cusip)).length;
  const auctionSecurities = new Set(input.dataset.auctions.map((value) => value.officialSecurityId)).size;
  const lifecycleSecurities = new Set(input.dataset.lifecycleEvents.map((value) => value.officialSecurityId)).size;
  const actualAuctionsBySecurity = new Map<string, typeof input.dataset.auctions>();
  for (const event of input.dataset.auctions.filter((value) => value.auctionDate <= input.snapshotDate)) {
    const values = actualAuctionsBySecurity.get(event.officialSecurityId) ?? [];
    values.push(event);
    actualAuctionsBySecurity.set(event.officialSecurityId, values);
  }
  const latestActual = [...actualAuctionsBySecurity.values()].map((events) =>
    [...events].sort((left, right) => right.auctionDate.localeCompare(left.auctionDate))[0],
  );
  const auctionPrice = latestActual.filter((value) => value.auctionPrice !== null).length;
  const auctionYield = latestActual.filter((value) => value.auctionYield !== null).length;
  const officialObservationClassified = input.dataset.instruments.filter((instrument) => {
    const entries = input.freshness.entries.filter((value) =>
      value.officialSecurityId === instrument.officialSecurityId && value.layer === "LATEST_OFFICIAL_OBSERVATION",
    );
    return entries.length === 1 && entries[0].status !== "UNKNOWN";
  }).length;
  const freshnessSecurities = new Set(input.freshness.entries
    .filter((value) => value.status !== "UNKNOWN")
    .map((value) => value.officialSecurityId)).size;
  const schedulerCompleted = input.schedulerOnline && input.productionLiveRunPassed;
  const maintenanceCompleted = schedulerCompleted
    && input.archiveCompleted
    && input.failureQueueOperational
    && input.retryOperational
    && input.lineageCompleted
    && input.terms.termsClassified === denominator
    && auctionSecurities === denominator;
  const rows = [
    layer({ layer: "Universe", status: denominator ? "COMPLETED" : "NOT_STARTED", denominator, numerator: denominator, blocker: null, owner: "Laptop/Master", nextAction: "Maintenance discovery only" }),
    layer({ layer: "Identity", status: validCusips === denominator ? "COMPLETED" : "PARTIAL", denominator, numerator: validCusips, blocker: validCusips === denominator ? null : "Invalid or missing official identifier", owner: "Laptop/Master", nextAction: "Retry unresolved identifiers" }),
    layer({ layer: "CUSIP", status: validCusips === denominator ? "COMPLETED" : "PARTIAL", denominator, numerator: validCusips, blocker: validCusips === denominator ? null : "Invalid or missing CUSIP", owner: "Laptop/Master", nextAction: "Retry unresolved identifiers" }),
    layer({ layer: "Terms", status: input.terms.termsClassified === denominator ? "COMPLETED" : "PARTIAL", denominator, numerator: input.terms.termsClassified, blocker: input.terms.termsClassified === denominator ? null : "Official terms not yet classified", owner: "Laptop/Master", nextAction: "Classify official gap without fabrication" }),
    layer({ layer: "Auction Historical", status: auctionSecurities === denominator ? "COMPLETED" : "PARTIAL", denominator, numerator: auctionSecurities, blocker: auctionSecurities === denominator ? null : "Official auction history gap", owner: "Laptop/Master", nextAction: "Resume from checkpoint" }),
    layer({ layer: "Lifecycle", status: lifecycleSecurities === denominator ? "COMPLETED" : "PARTIAL", denominator, numerator: lifecycleSecurities, blocker: lifecycleSecurities === denominator ? null : "Lifecycle event not derivable from official source", owner: "Laptop/Master", nextAction: "Retry lifecycle normalization" }),
    layer({ layer: "Latest official observation", status: officialObservationClassified === denominator ? "COMPLETED" : "PARTIAL", denominator, numerator: officialObservationClassified, blocker: officialObservationClassified === denominator ? null : "Actual result missing or source delayed", owner: "Railway Bond Production", nextAction: "Daily incremental and freshness validation" }),
    layer({ layer: "Latest auction price", status: auctionPrice === denominator ? "COMPLETED" : "PARTIAL", denominator, numerator: auctionPrice, blocker: auctionPrice === denominator ? null : "Future announcement or source does not expose a price yet", owner: "Railway Bond Production", nextAction: "Non-blocking retry after official result" }),
    layer({ layer: "Latest auction yield", status: auctionYield === denominator ? "COMPLETED" : "PARTIAL", denominator, numerator: auctionYield, blocker: auctionYield === denominator ? null : "Yield is not applicable or not supplied for every security type", owner: "Railway Bond Production", nextAction: "Preserve type-specific official rate fields" }),
    layer({ layer: "Secondary-market historical", status: "BLOCKED", denominator, numerator: 0, blocker: "SECONDARY_MARKET_HISTORY_BLOCKED_BY_SOURCE", owner: "Master", nextAction: "Obtain a licensed professional FINRA TRACE Treasury product or other authorized source" }),
    layer({ layer: "Secondary-market latest", status: "BLOCKED", denominator, numerator: 0, blocker: "SECONDARY_MARKET_LATEST_BLOCKED_BY_SOURCE", owner: "Master", nextAction: "Do not substitute auction prices or yield curves" }),
    layer({ layer: "Freshness", status: freshnessSecurities === denominator ? "COMPLETED" : "PARTIAL", denominator, numerator: freshnessSecurities, blocker: freshnessSecurities === denominator ? null : "At least one security has only UNKNOWN freshness", owner: "Railway Bond Production", nextAction: "Run validator after each incremental fetch" }),
    layer({ layer: "Incremental", status: input.productionLiveRunPassed ? "COMPLETED" : "PARTIAL", denominator, numerator: input.productionLiveRunPassed ? denominator : 0, blocker: input.productionLiveRunPassed ? null : "First managed production run not yet verified", owner: "Railway Bond Production", nextAction: "Complete first live bounded run" }),
    layer({ layer: "Scheduler", status: schedulerCompleted ? "COMPLETED" : input.schedulerOnline ? "PARTIAL" : "NOT_STARTED", denominator: 1, numerator: schedulerCompleted ? 1 : 0, blocker: schedulerCompleted ? null : "Dedicated Railway scheduler/live run gate", owner: "Railway Bond Production", nextAction: "Deploy isolated weekday schedule and verify first live run" }),
    layer({ layer: "Durable archive", status: input.archiveCompleted ? "COMPLETED" : "NOT_STARTED", denominator: 1, numerator: input.archiveCompleted ? 1 : 0, blocker: input.archiveCompleted ? null : "Durable object store is not verified", owner: "Railway Bond Production", nextAction: "Archive to mounted volume and replay checksums" }),
    layer({ layer: "Canonical DB", status: "PARTIAL", denominator: 6, numerator: 1, blocker: "Bond detail/event tables require owner-approved migration", owner: "Master", nextAction: "Use securities identity plus durable artifacts pending schema approval" }),
    layer({ layer: "Failure queue", status: input.failureQueueOperational ? "COMPLETED" : "NOT_STARTED", denominator: 1, numerator: input.failureQueueOperational ? 1 : 0, blocker: input.failureQueueOperational ? null : "Failure queue not verified", owner: "Railway Bond Production", nextAction: "Verify item failure remains non-blocking" }),
    layer({ layer: "Retry", status: input.retryOperational ? "COMPLETED" : "NOT_STARTED", denominator: 1, numerator: input.retryOperational ? 1 : 0, blocker: input.retryOperational ? null : "Retry recovery not verified", owner: "Railway Bond Production", nextAction: "Verify resolved failure is retained" }),
    layer({ layer: "Data lineage", status: input.lineageCompleted ? "COMPLETED" : "PARTIAL", denominator: 1, numerator: input.lineageCompleted ? 1 : 0, blocker: input.lineageCompleted ? null : "Durable manifest/source metadata incomplete", owner: "Railway Bond Production", nextAction: "Persist source document and parser lineage" }),
    layer({ layer: "Maintenance status", status: maintenanceCompleted ? "COMPLETED" : "PARTIAL", denominator: 1, numerator: maintenanceCompleted ? 1 : 0, blocker: maintenanceCompleted ? null : "Production scheduler/live-run/archive gates remain", owner: "Master", nextAction: maintenanceCompleted ? "Incremental/validation/retry only" : "Complete production gates" }),
  ];
  return {
    version: 1,
    asset: "BOND",
    market: "US_TREASURY",
    generatedAt: new Date().toISOString(),
    snapshotDate: input.snapshotDate,
    layers: rows,
    remainingLayers: rows.filter((value) => value.status !== "COMPLETED" && value.status !== "NOT_APPLICABLE" && value.status !== "BLOCKED").length,
    completedLayers: rows.filter((value) => value.status === "COMPLETED").length,
  };
}
