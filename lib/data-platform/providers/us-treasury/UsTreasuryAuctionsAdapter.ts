import { createHash } from "node:crypto";

export const US_TREASURY_SOURCE_NAMESPACE = "US_TREASURY_FISCAL_DATA";
export const US_TREASURY_AUCTIONS_ENDPOINT =
  "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query";
export const US_TREASURY_V1_CONTRACT = {
  version: "1.1",
  assetDomain: "BOND",
  market: "US_TREASURY",
  sourceNamespace: US_TREASURY_SOURCE_NAMESPACE,
  canonicalIdentity: ["sourceNamespace", "officialSecurityId"],
  identifierVisibility: "INTERNAL_ONLY",
  identifierLegalGate: "PENDING_CUSIP_REUSE_REVIEW",
  sourceUnsupportedLifecycleTypes: ["REDEEMED", "CANCELLED"],
  historicalJobId: "official-bond-us-treasury-historical",
  incrementalJobId: "official-bond-us-treasury-incremental",
  includedLayers: ["UNIVERSE", "IDENTITY", "TERMS", "AUCTION_HISTORY", "LIFECYCLE", "INCREMENTAL"],
  excludedLayers: ["SECONDARY_PRICE", "TRADABLE_PRICE", "BID_ASK", "DAILY_YTM_YTW", "SPREAD", "DURATION"],
} as const;

export const US_TREASURY_V1_FIELDS = [
  "record_date",
  "cusip",
  "security_type",
  "security_term",
  "auction_date",
  "issue_date",
  "maturity_date",
  "price_per100",
  "announcemt_date",
  "callable",
  "call_date",
  "called_date",
  "comp_accepted",
  "total_accepted",
  "offering_amt",
  "original_cusip",
  "original_issue_date",
  "reopening",
  "floating_rate",
  "int_payment_frequency",
  "int_rate",
  "high_yield",
  "high_price",
  "currently_outstanding",
  "frn_index_determination_date",
  "frn_index_determination_rate",
  "high_discnt_margin",
  "avg_med_discnt_margin",
  "high_discnt_rate",
  "high_investment_rate",
  "inflation_index_security",
] as const;

export type TreasuryRawAuction = Partial<Record<(typeof US_TREASURY_V1_FIELDS)[number], string | null>>;

type TreasuryApiPayload = {
  data?: TreasuryRawAuction[];
  meta?: {
    count?: number;
    "total-count"?: number;
    "total-pages"?: number;
  };
};

export type TreasuryRawPage = {
  sourceNamespace: typeof US_TREASURY_SOURCE_NAMESPACE;
  sourceDocumentId: string;
  fetchedAt: string;
  recordDate: string | null;
  contentHash: string;
  requestUrl: string;
  pageNumber: number;
  recordCount: number;
  totalCount: number;
  rawText: string;
};

export type TreasuryFetchOptions = {
  filters?: string[];
  sort?: string;
  pageSize?: number;
  maxPages?: number;
  onPage?: (page: TreasuryRawPage) => void | Promise<void>;
};

export type BondCouponTypeValue = "ZERO_COUPON" | "FIXED" | "FLOATING" | "INFLATION_INDEXED" | "UNKNOWN";
export type BondStatusValue = "ANNOUNCED" | "ACTIVE" | "MATURED" | "CALLED" | "REDEEMED" | "CANCELLED" | "UNKNOWN";
export type BondLifecycleTypeValue = "ANNOUNCED" | "ISSUED" | "REOPENED" | "MATURED" | "CALLED" | "REDEEMED" | "CANCELLED";

export type NormalizedTreasuryAuction = {
  sourceNamespace: typeof US_TREASURY_SOURCE_NAMESPACE;
  sourceEventId: string;
  officialSecurityId: string;
  cusip: string;
  securityType: string;
  securityTerm: string | null;
  announcementDate: string | null;
  auctionDate: string;
  issueDate: string;
  maturityDate: string | null;
  originalIssueDate: string | null;
  offeringAmount: string | null;
  acceptedAmount: string | null;
  auctionPrice: string | null;
  auctionYield: string | null;
  interestRate: string | null;
  currentOutstandingAmount: string | null;
  frnIndexDeterminationDate: string | null;
  frnIndexDeterminationRate: string | null;
  highDiscountMargin: string | null;
  averageMedianDiscountMargin: string | null;
  highDiscountRate: string | null;
  highInvestmentRate: string | null;
  reopening: boolean;
  couponType: BondCouponTypeValue;
  paymentFrequency: number | null;
  calledDate: string | null;
  sourceUpdatedAt: string | null;
};

export type NormalizedTreasuryInstrument = {
  sourceNamespace: typeof US_TREASURY_SOURCE_NAMESPACE;
  officialSecurityId: string;
  cusip: string;
  isin: null;
  name: string;
  securityType: string;
  securityTerm: string | null;
  country: "US";
  currency: "USD";
  issueDate: string | null;
  maturityDate: string | null;
  couponRate: string | null;
  couponType: BondCouponTypeValue;
  couponRateAvailability: "AVAILABLE" | "NOT_APPLICABLE" | "SOURCE_NOT_PROVIDED" | "ANNOUNCED_PENDING" | "UNKNOWN";
  currentOutstandingAmount: string | null;
  frnReferenceRate: string | null;
  frnReferenceRateDate: string | null;
  frnSpread: string | null;
  paymentFrequency: number | null;
  originalIssueDate: string | null;
  isReopening: boolean;
  status: BondStatusValue;
  sourceUpdatedAt: string | null;
};

export type NormalizedTreasuryLifecycle = {
  officialSecurityId: string;
  eventType: BondLifecycleTypeValue;
  effectiveDate: string;
  sourceNamespace: typeof US_TREASURY_SOURCE_NAMESPACE;
  sourceEventId: string;
  metadata: Record<string, string | boolean | null>;
};

export type NormalizedTreasuryDataset = {
  instruments: NormalizedTreasuryInstrument[];
  auctions: NormalizedTreasuryAuction[];
  lifecycleEvents: NormalizedTreasuryLifecycle[];
};

export const US_TREASURY_CANARY_TYPES = ["BILL", "NOTE", "BOND", "TIPS", "FRN"] as const;

export type TreasurySampleEvidence = {
  instrument: NormalizedTreasuryInstrument;
  auctions: NormalizedTreasuryAuction[];
  hasNewIssueEvent: boolean;
  hasReopeningEvent: boolean;
};

function eligibleTreasuryCandidates(dataset: NormalizedTreasuryDataset): TreasurySampleEvidence[] {
  const auctionsByInstrument = new Map<string, NormalizedTreasuryAuction[]>();
  for (const event of dataset.auctions) {
    const events = auctionsByInstrument.get(event.officialSecurityId) ?? [];
    events.push(event);
    auctionsByInstrument.set(event.officialSecurityId, events);
  }
  return dataset.instruments
    .filter((instrument) => instrument.status === "ACTIVE" || instrument.status === "ANNOUNCED")
    .map((instrument): TreasurySampleEvidence => {
      const auctions = auctionsByInstrument.get(instrument.officialSecurityId) ?? [];
      return {
        instrument,
        auctions,
        hasNewIssueEvent: auctions.some((event) => !event.reopening),
        hasReopeningEvent: auctions.some((event) => event.reopening),
      };
    });
}

export function selectFullEligibleTreasuryUniverse(dataset: NormalizedTreasuryDataset): TreasurySampleEvidence[] {
  return eligibleTreasuryCandidates(dataset)
    .sort((left, right) => left.instrument.officialSecurityId.localeCompare(right.instrument.officialSecurityId));
}

export function selectDeterministicTreasurySample(dataset: NormalizedTreasuryDataset, count: number): TreasurySampleEvidence[] {
  const candidates = eligibleTreasuryCandidates(dataset)
    .sort((left, right) => {
      const typeDifference = US_TREASURY_CANARY_TYPES.indexOf(left.instrument.securityType as (typeof US_TREASURY_CANARY_TYPES)[number])
        - US_TREASURY_CANARY_TYPES.indexOf(right.instrument.securityType as (typeof US_TREASURY_CANARY_TYPES)[number]);
      if (typeDifference !== 0) return typeDifference;
      return `${left.instrument.maturityDate ?? "9999-12-31"}:${left.instrument.officialSecurityId}`
        .localeCompare(`${right.instrument.maturityDate ?? "9999-12-31"}:${right.instrument.officialSecurityId}`);
    });
  const selected = new Map<string, TreasurySampleEvidence>();
  const add = (candidate: TreasurySampleEvidence | undefined): void => {
    if (candidate && selected.size < count) selected.set(candidate.instrument.officialSecurityId, candidate);
  };
  add(candidates.find((candidate) => candidate.instrument.status === "ANNOUNCED"));
  for (const requiredType of US_TREASURY_CANARY_TYPES) {
    const typeCandidates = candidates.filter((candidate) => candidate.instrument.securityType === requiredType);
    add(typeCandidates.find((candidate) => candidate.hasNewIssueEvent));
    add(typeCandidates.find((candidate) => candidate.hasReopeningEvent && !selected.has(candidate.instrument.officialSecurityId)));
  }
  let offset = 0;
  while (selected.size < count) {
    let added = false;
    for (const requiredType of US_TREASURY_CANARY_TYPES) {
      const candidate = candidates.filter((value) => value.instrument.securityType === requiredType)[offset];
      const before = selected.size;
      add(candidate);
      if (selected.size > before) added = true;
      if (selected.size === count) break;
    }
    if (!added && offset > candidates.length) break;
    offset += 1;
  }
  if (selected.size !== count) throw new Error(`CANARY_SAMPLE_SIZE_UNAVAILABLE:${selected.size}/${count}`);
  return [...selected.values()].sort((left, right) => left.instrument.officialSecurityId.localeCompare(right.instrument.officialSecurityId));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function textOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return !trimmed || trimmed.toLowerCase() === "null" ? null : trimmed;
}

function dateOrNull(value: string | null | undefined): string | null {
  const parsed = textOrNull(value);
  if (!parsed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed) || Number.isNaN(Date.parse(`${parsed}T00:00:00.000Z`))) {
    throw new Error(`TREASURY_INVALID_DATE:${parsed}`);
  }
  return parsed;
}

function decimalOrNull(value: string | null | undefined): string | null {
  const parsed = textOrNull(value);
  if (!parsed) return null;
  const numeric = Number(parsed.replaceAll(",", ""));
  if (!Number.isFinite(numeric)) throw new Error(`TREASURY_INVALID_NUMBER:${parsed}`);
  return parsed.replaceAll(",", "");
}

function yes(value: string | null | undefined): boolean {
  return textOrNull(value)?.toUpperCase() === "YES";
}

function paymentFrequency(value: string | null | undefined): number | null {
  const normalized = textOrNull(value)?.toUpperCase().replaceAll("-", " ");
  if (!normalized) return null;
  if (normalized === "NONE") return 0;
  if (normalized.includes("ANNUAL") && !normalized.includes("SEMI")) return 1;
  if (normalized.includes("SEMI")) return 2;
  if (normalized.includes("QUARTER")) return 4;
  if (normalized.includes("MONTH")) return 12;
  return null;
}

function couponType(record: TreasuryRawAuction): BondCouponTypeValue {
  if (yes(record.inflation_index_security)) return "INFLATION_INDEXED";
  if (yes(record.floating_rate)) return "FLOATING";
  if (textOrNull(record.security_type)?.toUpperCase() === "BILL") return "ZERO_COUPON";
  if (decimalOrNull(record.int_rate) !== null) return "FIXED";
  return "UNKNOWN";
}

function securityType(record: TreasuryRawAuction): string {
  if (yes(record.inflation_index_security)) return "TIPS";
  if (yes(record.floating_rate)) return "FRN";
  return textOrNull(record.security_type)?.toUpperCase() ?? "UNKNOWN";
}

function maxDate(values: Array<string | null>): string | null {
  return values.filter((value): value is string => value !== null).sort().at(-1) ?? null;
}

function minDate(values: Array<string | null>): string | null {
  return values.filter((value): value is string => value !== null).sort().at(0) ?? null;
}

function latestNonNull<T>(events: NormalizedTreasuryAuction[], select: (event: NormalizedTreasuryAuction) => T | null): T | null {
  const ordered = [...events].sort((left, right) =>
    `${right.sourceUpdatedAt ?? ""}:${right.auctionDate}`.localeCompare(`${left.sourceUpdatedAt ?? ""}:${left.auctionDate}`),
  );
  for (const event of ordered) {
    const value = select(event);
    if (value !== null) return value;
  }
  return null;
}

function statusFor(events: NormalizedTreasuryAuction[], issueDate: string | null, maturityDate: string | null, snapshotDate: string): BondStatusValue {
  const calledDate = minDate(events.map((event) => event.calledDate));
  if (calledDate && calledDate <= snapshotDate) return "CALLED";
  if (maturityDate && maturityDate < snapshotDate) return "MATURED";
  if (issueDate && issueDate > snapshotDate) return "ANNOUNCED";
  if (issueDate && issueDate <= snapshotDate && (!maturityDate || maturityDate >= snapshotDate)) return "ACTIVE";
  return "UNKNOWN";
}

export function normalizeTreasuryAuction(record: TreasuryRawAuction): NormalizedTreasuryAuction {
  const cusip = textOrNull(record.cusip);
  const auctionDate = dateOrNull(record.auction_date);
  const issueDate = dateOrNull(record.issue_date);
  if (!cusip) throw new Error("TREASURY_CUSIP_REQUIRED");
  if (!auctionDate) throw new Error(`TREASURY_AUCTION_DATE_REQUIRED:${cusip}`);
  if (!issueDate) throw new Error(`TREASURY_ISSUE_DATE_REQUIRED:${cusip}:${auctionDate}`);
  const eventId = `${cusip}:${auctionDate}:${issueDate}`;
  return {
    sourceNamespace: US_TREASURY_SOURCE_NAMESPACE,
    sourceEventId: eventId,
    officialSecurityId: cusip,
    cusip,
    securityType: securityType(record),
    securityTerm: textOrNull(record.security_term),
    announcementDate: dateOrNull(record.announcemt_date),
    auctionDate,
    issueDate,
    maturityDate: dateOrNull(record.maturity_date),
    originalIssueDate: dateOrNull(record.original_issue_date),
    offeringAmount: decimalOrNull(record.offering_amt),
    acceptedAmount: decimalOrNull(record.total_accepted) ?? decimalOrNull(record.comp_accepted),
    auctionPrice: decimalOrNull(record.price_per100) ?? decimalOrNull(record.high_price),
    auctionYield: decimalOrNull(record.high_yield),
    interestRate: decimalOrNull(record.int_rate),
    currentOutstandingAmount: decimalOrNull(record.currently_outstanding),
    frnIndexDeterminationDate: dateOrNull(record.frn_index_determination_date),
    frnIndexDeterminationRate: decimalOrNull(record.frn_index_determination_rate),
    highDiscountMargin: decimalOrNull(record.high_discnt_margin),
    averageMedianDiscountMargin: decimalOrNull(record.avg_med_discnt_margin),
    highDiscountRate: decimalOrNull(record.high_discnt_rate),
    highInvestmentRate: decimalOrNull(record.high_investment_rate),
    reopening: yes(record.reopening),
    couponType: couponType(record),
    paymentFrequency: paymentFrequency(record.int_payment_frequency),
    calledDate: dateOrNull(record.called_date),
    sourceUpdatedAt: dateOrNull(record.record_date),
  };
}

export function buildTreasuryDataset(records: TreasuryRawAuction[], snapshotDate: string): NormalizedTreasuryDataset {
  dateOrNull(snapshotDate);
  const deduplicatedEvents = new Map<string, NormalizedTreasuryAuction>();
  for (const record of records) {
    const event = normalizeTreasuryAuction(record);
    const prior = deduplicatedEvents.get(event.sourceEventId);
    if (!prior || (event.sourceUpdatedAt ?? "") >= (prior.sourceUpdatedAt ?? "")) deduplicatedEvents.set(event.sourceEventId, event);
  }
  const auctions = [...deduplicatedEvents.values()].sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId));
  const byInstrument = new Map<string, NormalizedTreasuryAuction[]>();
  for (const event of auctions) {
    const existing = byInstrument.get(event.officialSecurityId) ?? [];
    existing.push(event);
    byInstrument.set(event.officialSecurityId, existing);
  }

  const instruments: NormalizedTreasuryInstrument[] = [];
  const lifecycleEvents: NormalizedTreasuryLifecycle[] = [];
  for (const [officialSecurityId, events] of [...byInstrument.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const issueDate = minDate(events.map((event) => event.originalIssueDate ?? event.issueDate));
    const maturityDate = latestNonNull(events, (event) => event.maturityDate);
    const type = latestNonNull(events, (event) => event.securityType) ?? "UNKNOWN";
    const term = latestNonNull(events, (event) => event.securityTerm);
    const rate = latestNonNull(events, (event) => event.interestRate);
    const resolvedCouponType = latestNonNull(events, (event) => event.couponType) ?? "UNKNOWN";
    const instrumentStatus = statusFor(events, issueDate, maturityDate, snapshotDate);
    const instrument: NormalizedTreasuryInstrument = {
      sourceNamespace: US_TREASURY_SOURCE_NAMESPACE,
      officialSecurityId,
      cusip: officialSecurityId,
      isin: null,
      name: `U.S. Treasury ${term ?? "Unknown Term"} ${type}`,
      securityType: type,
      securityTerm: term,
      country: "US",
      currency: "USD",
      issueDate,
      maturityDate,
      couponRate: rate,
      couponType: resolvedCouponType,
      couponRateAvailability: rate !== null
        ? "AVAILABLE"
        : resolvedCouponType === "ZERO_COUPON"
          ? "NOT_APPLICABLE"
          : resolvedCouponType === "FLOATING"
            ? "SOURCE_NOT_PROVIDED"
            : instrumentStatus === "ANNOUNCED"
              ? "ANNOUNCED_PENDING"
              : "UNKNOWN",
      currentOutstandingAmount: latestNonNull(events, (event) => event.currentOutstandingAmount),
      frnReferenceRate: latestNonNull(events, (event) => event.frnIndexDeterminationRate),
      frnReferenceRateDate: latestNonNull(events, (event) => event.frnIndexDeterminationDate),
      frnSpread: latestNonNull(events, (event) => event.highDiscountMargin ?? event.averageMedianDiscountMargin),
      paymentFrequency: latestNonNull(events, (event) => event.paymentFrequency),
      originalIssueDate: minDate(events.map((event) => event.originalIssueDate)),
      isReopening: events.some((event) => event.reopening),
      status: instrumentStatus,
      sourceUpdatedAt: maxDate(events.map((event) => event.sourceUpdatedAt)),
    };
    instruments.push(instrument);

    for (const event of events) {
      if (event.announcementDate) lifecycleEvents.push({
        officialSecurityId,
        eventType: "ANNOUNCED",
        effectiveDate: event.announcementDate,
        sourceNamespace: US_TREASURY_SOURCE_NAMESPACE,
        sourceEventId: event.sourceEventId,
        metadata: { reopening: event.reopening, auctionDate: event.auctionDate },
      });
      if (event.issueDate <= snapshotDate) lifecycleEvents.push({
        officialSecurityId,
        eventType: "ISSUED",
        effectiveDate: event.issueDate,
        sourceNamespace: US_TREASURY_SOURCE_NAMESPACE,
        sourceEventId: event.sourceEventId,
        metadata: { reopening: event.reopening, auctionDate: event.auctionDate },
      });
      if (event.reopening && event.issueDate <= snapshotDate) lifecycleEvents.push({
        officialSecurityId,
        eventType: "REOPENED",
        effectiveDate: event.issueDate,
        sourceNamespace: US_TREASURY_SOURCE_NAMESPACE,
        sourceEventId: event.sourceEventId,
        metadata: { auctionDate: event.auctionDate },
      });
      if (event.calledDate && event.calledDate <= snapshotDate) lifecycleEvents.push({
        officialSecurityId,
        eventType: "CALLED",
        effectiveDate: event.calledDate,
        sourceNamespace: US_TREASURY_SOURCE_NAMESPACE,
        sourceEventId: event.sourceEventId,
        metadata: { auctionDate: event.auctionDate },
      });
    }
    if (maturityDate && maturityDate < snapshotDate) lifecycleEvents.push({
      officialSecurityId,
      eventType: "MATURED",
      effectiveDate: maturityDate,
      sourceNamespace: US_TREASURY_SOURCE_NAMESPACE,
      sourceEventId: `${officialSecurityId}:MATURITY:${maturityDate}`,
      metadata: { maturityDate },
    });
  }

  const lifecycleByKey = new Map<string, NormalizedTreasuryLifecycle>();
  for (const event of lifecycleEvents) lifecycleByKey.set(`${event.sourceNamespace}:${event.sourceEventId}:${event.eventType}`, event);
  return {
    instruments,
    auctions,
    lifecycleEvents: [...lifecycleByKey.values()].sort((left, right) =>
      `${left.officialSecurityId}:${left.effectiveDate}:${left.eventType}`.localeCompare(`${right.officialSecurityId}:${right.effectiveDate}:${right.eventType}`),
    ),
  };
}

export function isValidCusip(cusip: string): boolean {
  if (!/^[0-9A-Z*@#]{9}$/.test(cusip)) return false;
  const value = (character: string): number => {
    if (/\d/.test(character)) return Number(character);
    if (/[A-Z]/.test(character)) return character.charCodeAt(0) - 55;
    return character === "*" ? 36 : character === "@" ? 37 : 38;
  };
  let sum = 0;
  for (let index = 0; index < 8; index += 1) {
    const product = value(cusip[index]) * (index % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 10) + (product % 10);
  }
  return (10 - (sum % 10)) % 10 === Number(cusip[8]);
}

export class UsTreasuryAuctionsAdapter {
  readonly sourceNamespace = US_TREASURY_SOURCE_NAMESPACE;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly requestDelayMs: number;

  constructor(options: { userAgent?: string; timeoutMs?: number; maxRetries?: number; requestDelayMs?: number } = {}) {
    this.userAgent = options.userAgent ?? process.env.SMARTFUND_DATA_USER_AGENT ?? "SmartFund/1.0 official-data adapter";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.requestDelayMs = options.requestDelayMs ?? 250;
  }

  async fetchAuctions(options: TreasuryFetchOptions = {}): Promise<TreasuryRawAuction[]> {
    const pageSize = Math.min(Math.max(options.pageSize ?? 1_000, 1), 10_000);
    const records: TreasuryRawAuction[] = [];
    let pageNumber = 1;
    let totalPages = 1;
    do {
      if (options.maxPages && pageNumber > options.maxPages) break;
      const url = new URL(US_TREASURY_AUCTIONS_ENDPOINT);
      url.searchParams.set("fields", US_TREASURY_V1_FIELDS.join(","));
      if (options.filters?.length) url.searchParams.set("filter", options.filters.join(","));
      url.searchParams.set("sort", options.sort ?? "record_date,cusip,auction_date,issue_date");
      url.searchParams.set("page[number]", String(pageNumber));
      url.searchParams.set("page[size]", String(pageSize));
      const { payload, rawText, fetchedAt } = await this.fetchPage(url);
      const pageRecords = payload.data ?? [];
      totalPages = Math.max(1, Number(payload.meta?.["total-pages"] ?? 1));
      const contentHash = createHash("sha256").update(rawText).digest("hex");
      const page: TreasuryRawPage = {
        sourceNamespace: US_TREASURY_SOURCE_NAMESPACE,
        sourceDocumentId: `auctions_query:${createHash("sha256").update(url.toString()).digest("hex")}`,
        fetchedAt,
        recordDate: maxDate(pageRecords.map((record) => dateOrNull(record.record_date))),
        contentHash,
        requestUrl: url.toString(),
        pageNumber,
        recordCount: pageRecords.length,
        totalCount: Number(payload.meta?.["total-count"] ?? pageRecords.length),
        rawText,
      };
      await options.onPage?.(page);
      records.push(...pageRecords);
      pageNumber += 1;
      if (pageNumber <= totalPages) await sleep(this.requestDelayMs);
    } while (pageNumber <= totalPages);
    return records;
  }

  private async fetchPage(url: URL): Promise<{ payload: TreasuryApiPayload; rawText: string; fetchedAt: string }> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": this.userAgent },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          if (!retryable || attempt === this.maxRetries) throw new Error(`TREASURY_HTTP_${response.status}`);
          const retryAfter = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(retryAfter) ? retryAfter * 1_000 : 500 * 2 ** attempt);
          continue;
        }
        const rawText = await response.text();
        const payload = JSON.parse(rawText) as TreasuryApiPayload;
        if (!Array.isArray(payload.data)) throw new Error("TREASURY_RESPONSE_DATA_REQUIRED");
        return { payload, rawText, fetchedAt: new Date().toISOString() };
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries) break;
        await sleep(500 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
