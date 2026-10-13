export type AssetType = "STOCK" | "ETF" | "FUND" | "INDEX" | "FX";

export type FreshnessStatus =
  | "CURRENT"
  | "HEALTHY_WAITING"
  | "PARTIAL_CURRENT"
  | "SOURCE_RECOVERY_PENDING"
  | "LICENSE_PENDING"
  | "STALE"
  | "UNKNOWN";

export type CoverageStatus = "FULL" | "PARTIAL_CURRENT" | "SOURCE_RECOVERY_PENDING" | "LICENSE_PENDING" | "UNKNOWN";

export interface CanonicalIdentity {
  assetType: AssetType;
  id: string;
  symbol: string;
  name: string;
  displayName: string;
  currency: string | null;
  market: string | null;
  country: string | null;
}

export interface SummaryMetrics {
  priceOrNav: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string | null;
  asOfDate: string | null;
  performance1M: number | null;
  performance3M: number | null;
  performance1Y: number | null;
}

export interface Provenance {
  source: string | null;
  sourceType: "OFFICIAL" | "APPROVED_MARKET_DATA" | "VERIFIED_PROVIDER" | "UNKNOWN";
  sourceRecordId: string | null;
  asOfDate: string | null;
  lastUpdated: string | null;
  provenanceStatus: "VERIFIED" | "SOURCE_NOT_EXPOSED";
}

export interface ResponseMeta {
  asOfDate: string | null;
  lastUpdated: string | null;
  freshnessStatus: FreshnessStatus;
  source: string | null;
  provenance: Provenance;
  coverageStatus: CoverageStatus;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  hasNextPage: boolean;
  nextCursor: string | null;
}

export interface ServiceErrorShape {
  code: "NOT_FOUND" | "INVALID_QUERY" | "INVALID_PAGINATION" | "DATA_UNAVAILABLE" | "SOURCE_PENDING" | "INTERNAL_ERROR";
  message: string;
}

export interface ServiceResponse<T> {
  data: T | null;
  meta: ResponseMeta;
  pagination: PaginationMeta | null;
  error: ServiceErrorShape | null;
}

export interface ListQuery {
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface HistoryQuery {
  page?: number;
  pageSize?: number;
  cursor?: string;
  from?: Date;
  to?: Date;
}

export const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const isoOrNull = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;
