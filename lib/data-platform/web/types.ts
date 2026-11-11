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
  /** The date these performance figures are as of (etf_performances/fund_performances' own
   * `date` column) -- NOT the same as `asOfDate` above, which is the price/NAV date. Null when
   * no performance row exists yet. */
  performanceAsOfDate?: string | null;
  /** Authoritative (Yahoo-sourced) trailing dividend yield, percent units. Null when not available. */
  dividendYield: number | null;
  // 2026-11-10（上架前審查第4項，使用者核准）: priceOrNav/change/changePercent是「市價，缺就退回
  // 淨值」的混合欄位，舊的change可能拿今天市價減昨天淨值——上市ETF要market price跟NAV各自獨立
  // 算自己的漲跌，不能互相頂替。這三個欄位目前只有getEtfDetail()會填，其餘呼叫端（列表頁等）
  // 維持用priceOrNav/change，是選用擴充欄位，不影響既有行為。
  marketPrice?: number | null;
  marketPriceChange?: number | null;
  marketPriceChangePercent?: number | null;
  navValue?: number | null;
  navChange?: number | null;
  navChangePercent?: number | null;
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
  // 2026-11-11（使用者核准，分割還原換算標示）: 只有getEtfHistory/getStockHistory在回傳的歷史價格
  // 裡含有依官方公告比例自行換算（見lib/data-platform/knownSplitEvents.ts）的分割前資料時才會有值，
  // 其餘所有service一律不設這個欄位。
  splitAdjustmentNote?: string | null;
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
