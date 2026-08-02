import type {
  NormalizedTreasuryAuction,
  NormalizedTreasuryDataset,
  NormalizedTreasuryInstrument,
} from "./UsTreasuryAuctionsAdapter.ts";

export const US_TREASURY_FRESHNESS_VALIDATOR_VERSION = "1.0.0";

export type TreasuryFreshnessStatus =
  | "FRESH"
  | "STALE"
  | "FUTURE_ANNOUNCEMENT"
  | "MATURED"
  | "ANNOUNCED_NOT_ISSUED"
  | "NO_MARKET_PRICE_SOURCE"
  | "SOURCE_DELAYED"
  | "UNKNOWN";

export type TreasuryFreshnessLayer =
  | "UNIVERSE"
  | "TERMS"
  | "AUCTION_ANNOUNCEMENT"
  | "AUCTION_RESULT"
  | "LIFECYCLE"
  | "LATEST_OFFICIAL_OBSERVATION"
  | "SECONDARY_MARKET_PRICE";

export type TreasuryFreshnessEntry = {
  officialSecurityId: string;
  layer: TreasuryFreshnessLayer;
  expectedUpdateDate: string | null;
  latestSourceDate: string | null;
  latestActualObservationDate: string | null;
  staleDays: number | null;
  status: TreasuryFreshnessStatus;
  reason: string;
  validatorVersion: typeof US_TREASURY_FRESHNESS_VALIDATOR_VERSION;
};

export type TreasuryTermsCoverage = {
  denominator: number;
  termsClassified: number;
  couponAvailable: number;
  couponNotApplicable: number;
  couponSourceNotProvided: number;
  couponAnnouncedPending: number;
  couponUnknown: number;
  issueDate: number;
  maturityDate: number;
  securityType: number;
  outstandingAmount: number;
  auctionHistory: number;
  classifiedCoveragePercent: number;
};

export type TreasuryFreshnessLedger = {
  sourceNamespace: string;
  snapshotDate: string;
  generatedAt: string;
  validatorVersion: typeof US_TREASURY_FRESHNESS_VALIDATOR_VERSION;
  entries: TreasuryFreshnessEntry[];
  summary: Record<TreasuryFreshnessLayer, Record<TreasuryFreshnessStatus, number>>;
  measurable: number;
  denominator: number;
  coveragePercent: number;
};

function maxDate(values: Array<string | null | undefined>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function minDate(values: Array<string | null | undefined>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(0) ?? null;
}

function daysBetween(earlier: string, later: string): number {
  return Math.max(0, Math.floor((Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / 86_400_000));
}

function resultAvailable(event: NormalizedTreasuryAuction): boolean {
  if (event.securityType === "FRN") {
    return event.auctionPrice !== null
      || event.frnIndexDeterminationRate !== null
      || event.highDiscountMargin !== null
      || event.averageMedianDiscountMargin !== null;
  }
  if (event.securityType === "BILL") {
    return event.auctionPrice !== null || event.highDiscountRate !== null || event.highInvestmentRate !== null;
  }
  return event.auctionPrice !== null || event.auctionYield !== null || event.interestRate !== null;
}

function classifiedTerms(instrument: NormalizedTreasuryInstrument): boolean {
  return Boolean(
    instrument.issueDate
      && instrument.maturityDate
      && instrument.securityType !== "UNKNOWN"
      && instrument.couponRateAvailability !== "UNKNOWN",
  );
}

function entry(
  instrument: NormalizedTreasuryInstrument,
  layer: TreasuryFreshnessLayer,
  expectedUpdateDate: string | null,
  latestSourceDate: string | null,
  latestActualObservationDate: string | null,
  status: TreasuryFreshnessStatus,
  reason: string,
  snapshotDate: string,
): TreasuryFreshnessEntry {
  const staleDays = expectedUpdateDate && expectedUpdateDate < snapshotDate && latestActualObservationDate !== expectedUpdateDate
    ? daysBetween(expectedUpdateDate, snapshotDate)
    : status === "STALE" && latestActualObservationDate
      ? daysBetween(latestActualObservationDate, snapshotDate)
      : status === "STALE"
        ? null
        : 0;
  return {
    officialSecurityId: instrument.officialSecurityId,
    layer,
    expectedUpdateDate,
    latestSourceDate,
    latestActualObservationDate,
    staleDays,
    status,
    reason,
    validatorVersion: US_TREASURY_FRESHNESS_VALIDATOR_VERSION,
  };
}

function perInstrumentEntries(
  instrument: NormalizedTreasuryInstrument,
  events: NormalizedTreasuryAuction[],
  snapshotDate: string,
): TreasuryFreshnessEntry[] {
  const actual = events.filter((event) => event.auctionDate <= snapshotDate);
  const future = events.filter((event) => event.auctionDate > snapshotDate);
  const latestActual = [...actual].sort((left, right) => right.auctionDate.localeCompare(left.auctionDate))[0] ?? null;
  const nextFuture = [...future].sort((left, right) => left.auctionDate.localeCompare(right.auctionDate))[0] ?? null;
  const latestSourceDate = maxDate(events.map((event) => event.sourceUpdatedAt));
  const latestActualDate = latestActual?.auctionDate ?? null;
  const announcementDate = maxDate(events.map((event) => event.announcementDate));
  const nextAnnouncementDate = minDate(future.map((event) => event.announcementDate));
  const matured = Boolean(instrument.maturityDate && instrument.maturityDate < snapshotDate);
  const notIssued = Boolean(instrument.issueDate && instrument.issueDate > snapshotDate);

  const universeStatus: TreasuryFreshnessStatus = matured ? "MATURED" : notIssued ? "ANNOUNCED_NOT_ISSUED" : "FRESH";
  const universeReason = matured
    ? "Official maturity date precedes the snapshot date."
    : notIssued
      ? "Official security is announced but its issue date is in the future."
      : "Security remains present in the official eligible universe snapshot.";

  let termsStatus: TreasuryFreshnessStatus;
  let termsReason: string;
  if (matured) {
    termsStatus = "MATURED";
    termsReason = "Terms remain measurable but the instrument has matured.";
  } else if (notIssued && !classifiedTerms(instrument)) {
    termsStatus = "ANNOUNCED_NOT_ISSUED";
    termsReason = "Official terms are pending before issue.";
  } else if (classifiedTerms(instrument)) {
    termsStatus = "FRESH";
    termsReason = instrument.couponRateAvailability === "SOURCE_NOT_PROVIDED"
      ? "FRN fixed coupon rate is not provided by the source; official floating reference-rate fields classify the term."
      : instrument.couponRateAvailability === "NOT_APPLICABLE"
        ? "Treasury bill is zero-coupon; a coupon rate is not applicable."
        : "Required terms are present in the official source.";
  } else {
    termsStatus = "SOURCE_DELAYED";
    termsReason = "At least one required official term remains unclassified.";
  }

  const announcementStatus: TreasuryFreshnessStatus = nextFuture
    ? "FUTURE_ANNOUNCEMENT"
    : announcementDate
      ? "FRESH"
      : "UNKNOWN";
  const announcementReason = nextFuture
    ? "A later official auction is announced; its future date is not treated as an observed result."
    : announcementDate
      ? "Latest official announcement is recorded."
      : "No official announcement date is available.";

  let resultStatus: TreasuryFreshnessStatus;
  let resultReason: string;
  if (!latestActual && nextFuture) {
    resultStatus = "FUTURE_ANNOUNCEMENT";
    resultReason = "Only a future auction is available; no result is expected yet.";
  } else if (!latestActual && notIssued) {
    resultStatus = "ANNOUNCED_NOT_ISSUED";
    resultReason = "The security has not yet reached its first auction result date.";
  } else if (!latestActual) {
    resultStatus = "UNKNOWN";
    resultReason = "No actual auction observation is available.";
  } else if (resultAvailable(latestActual)) {
    resultStatus = matured ? "MATURED" : "FRESH";
    resultReason = "Latest non-future official auction has at least one type-appropriate result field.";
  } else {
    resultStatus = "SOURCE_DELAYED";
    resultReason = "Latest actual auction exists but official result fields are not yet populated.";
  }

  const lifecycleStatus: TreasuryFreshnessStatus = matured
    ? "MATURED"
    : notIssued
      ? "ANNOUNCED_NOT_ISSUED"
      : "FRESH";
  const lifecycleReason = matured
    ? "Maturity lifecycle event is derived from the official maturity date."
    : notIssued
      ? "Issue lifecycle event is not due yet."
      : "Official issue/maturity dates classify the current lifecycle.";

  const officialStatus: TreasuryFreshnessStatus = resultStatus;
  const officialReason = resultReason;

  return [
    entry(instrument, "UNIVERSE", null, latestSourceDate, latestSourceDate, universeStatus, universeReason, snapshotDate),
    entry(instrument, "TERMS", null, latestSourceDate, latestSourceDate, termsStatus, termsReason, snapshotDate),
    entry(instrument, "AUCTION_ANNOUNCEMENT", nextAnnouncementDate, latestSourceDate, announcementDate, announcementStatus, announcementReason, snapshotDate),
    entry(instrument, "AUCTION_RESULT", nextFuture?.auctionDate ?? null, latestSourceDate, latestActualDate, resultStatus, resultReason, snapshotDate),
    entry(instrument, "LIFECYCLE", instrument.maturityDate, latestSourceDate, instrument.issueDate, lifecycleStatus, lifecycleReason, snapshotDate),
    entry(instrument, "LATEST_OFFICIAL_OBSERVATION", nextFuture?.auctionDate ?? null, latestSourceDate, latestActualDate, officialStatus, officialReason, snapshotDate),
    entry(instrument, "SECONDARY_MARKET_PRICE", null, null, null, "NO_MARKET_PRICE_SOURCE", "Treasury auction data is not an individual-security secondary-market price source.", snapshotDate),
  ];
}

export function buildTreasuryFreshnessLedger(dataset: NormalizedTreasuryDataset, snapshotDate: string): TreasuryFreshnessLedger {
  const eventsBySecurity = new Map<string, NormalizedTreasuryAuction[]>();
  for (const event of dataset.auctions) {
    const values = eventsBySecurity.get(event.officialSecurityId) ?? [];
    values.push(event);
    eventsBySecurity.set(event.officialSecurityId, values);
  }
  const entries = dataset.instruments.flatMap((instrument) =>
    perInstrumentEntries(instrument, eventsBySecurity.get(instrument.officialSecurityId) ?? [], snapshotDate),
  );
  const layers: TreasuryFreshnessLayer[] = [
    "UNIVERSE",
    "TERMS",
    "AUCTION_ANNOUNCEMENT",
    "AUCTION_RESULT",
    "LIFECYCLE",
    "LATEST_OFFICIAL_OBSERVATION",
    "SECONDARY_MARKET_PRICE",
  ];
  const statuses: TreasuryFreshnessStatus[] = [
    "FRESH",
    "STALE",
    "FUTURE_ANNOUNCEMENT",
    "MATURED",
    "ANNOUNCED_NOT_ISSUED",
    "NO_MARKET_PRICE_SOURCE",
    "SOURCE_DELAYED",
    "UNKNOWN",
  ];
  const summary = Object.fromEntries(layers.map((layer) => [
    layer,
    Object.fromEntries(statuses.map((status) => [status, entries.filter((value) => value.layer === layer && value.status === status).length])),
  ])) as Record<TreasuryFreshnessLayer, Record<TreasuryFreshnessStatus, number>>;
  const measurable = entries.filter((value) => value.status !== "UNKNOWN").length;
  return {
    sourceNamespace: dataset.instruments[0]?.sourceNamespace ?? "US_TREASURY_FISCAL_DATA",
    snapshotDate,
    generatedAt: new Date().toISOString(),
    validatorVersion: US_TREASURY_FRESHNESS_VALIDATOR_VERSION,
    entries,
    summary,
    measurable,
    denominator: entries.length,
    coveragePercent: entries.length ? Number((measurable / entries.length * 100).toFixed(3)) : 0,
  };
}

export function calculateTreasuryTermsCoverage(dataset: NormalizedTreasuryDataset): TreasuryTermsCoverage {
  const denominator = dataset.instruments.length;
  const auctionsBySecurity = new Set(dataset.auctions.map((event) => event.officialSecurityId));
  const termsClassified = dataset.instruments.filter(classifiedTerms).length;
  return {
    denominator,
    termsClassified,
    couponAvailable: dataset.instruments.filter((value) => value.couponRateAvailability === "AVAILABLE").length,
    couponNotApplicable: dataset.instruments.filter((value) => value.couponRateAvailability === "NOT_APPLICABLE").length,
    couponSourceNotProvided: dataset.instruments.filter((value) => value.couponRateAvailability === "SOURCE_NOT_PROVIDED").length,
    couponAnnouncedPending: dataset.instruments.filter((value) => value.couponRateAvailability === "ANNOUNCED_PENDING").length,
    couponUnknown: dataset.instruments.filter((value) => value.couponRateAvailability === "UNKNOWN").length,
    issueDate: dataset.instruments.filter((value) => value.issueDate !== null).length,
    maturityDate: dataset.instruments.filter((value) => value.maturityDate !== null).length,
    securityType: dataset.instruments.filter((value) => value.securityType !== "UNKNOWN").length,
    outstandingAmount: dataset.instruments.filter((value) => value.currentOutstandingAmount !== null).length,
    auctionHistory: dataset.instruments.filter((value) => auctionsBySecurity.has(value.officialSecurityId)).length,
    classifiedCoveragePercent: denominator ? Number((termsClassified / denominator * 100).toFixed(3)) : 0,
  };
}
