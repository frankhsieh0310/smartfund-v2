import { createHash } from "node:crypto";

export const TAIWAN_GOVERNMENT_BOND_SOURCE_NAMESPACE = "TPEx_OPENAPI_GOVERNMENT_BOND_ISSUANCE" as const;
export const TAIWAN_GOVERNMENT_BOND_ENDPOINT = "https://www.tpex.org.tw/openapi/v1/bond_ISSBD1_data";
export const TAIWAN_GOVERNMENT_BOND_PARSER_VERSION = "1.0.0";

export const TAIWAN_GOVERNMENT_BOND_V1_CONTRACT = {
  market: "TAIWAN_GOVERNMENT",
  historicalJobId: "official-bond-taiwan-government-historical",
  incrementalJobId: "official-bond-taiwan-government-incremental",
} as const;

export type TaiwanGovernmentBondRaw = {
  Date: string;
  IssuerCode: string;
  IssuerName: string;
  BondCode: string;
  BondType: string;
  SeriesNumber: string;
  TrancheNumber: string;
  IssueDate: string;
  MaturityDate: string;
  IssueAmount: string;
  OutstandingAmount: string;
  CouponRate: string;
  InterestBasis: string;
  CouponFrequency: string;
  PaidFrequency: string;
  BondRatingAgency: string;
  BondRating: string;
  IssuerRatingAgency: string;
  IssuerRating: string;
  GuarantorRatingAgency: string;
  GuarantorRating: string;
  ListingCountry: string;
  PrincipalRepayment: string;
  PrincipalRepaymentDescription: string;
  ShortName: string;
  ListingDate: string;
  TenorYear: string;
  TenorMonth: string;
  ListingStatus: string;
  Guaranteed: string;
  GuaranteeDescription: string;
  PutOptionDate: string;
  PutOptionPrice: string;
  Underwriter: string;
  OutstandingChangeDate: string;
  OutstandingChangeDescription: string;
  Currency: string;
  OfferingMethod: string;
  "Conversion/ExchangePriceAtIssuance": string;
  "Conversion/ExchangePeriodStartDate": string;
  "Conversion/ExchangePeriodEndDate": string;
  Trustee: string;
};

export type TaiwanGovernmentBondSourceDocument = {
  sourceNamespace: typeof TAIWAN_GOVERNMENT_BOND_SOURCE_NAMESPACE;
  sourceDocumentId: string;
  requestUrl: string;
  fetchedAt: string;
  sourceDate: string | null;
  contentHash: string;
  recordCount: number;
  rawText: string;
};

export type NormalizedTaiwanGovernmentBond = {
  sourceNamespace: typeof TAIWAN_GOVERNMENT_BOND_SOURCE_NAMESPACE;
  officialSecurityId: string;
  issuerCode: string;
  issuerName: string;
  name: string;
  country: "TW";
  currency: "TWD";
  bondType: "GOVERNMENT_BOND";
  seriesNumber: string | null;
  trancheNumber: string | null;
  issueDate: string;
  maturityDate: string;
  listingDate: string | null;
  issueAmount: string;
  outstandingAmount: string;
  couponRate: string;
  couponType: "FIXED";
  couponFrequency: number | null;
  paymentFrequency: number | null;
  tenorYears: number | null;
  tenorMonths: number | null;
  listingStatusCode: string;
  sourceDate: string;
  sourcePayloadHash: string;
  status: "ACTIVE" | "MATURED" | "ANNOUNCED";
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function nullableText(value: unknown): string | null {
  return text(value) || null;
}

function yyyymmdd(value: unknown, field: string, required = true): string | null {
  const normalized = text(value);
  if (!normalized && !required) return null;
  if (!/^\d{8}$/.test(normalized)) throw new Error(`TPEX_TW_BOND_INVALID_DATE:${field}:${normalized}`);
  const parsed = `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  if (Number.isNaN(Date.parse(`${parsed}T00:00:00.000Z`))) throw new Error(`TPEX_TW_BOND_INVALID_DATE:${field}:${normalized}`);
  return parsed;
}

function decimal(value: unknown, field: string): string {
  const normalized = text(value).replaceAll(",", "");
  if (!normalized || !Number.isFinite(Number(normalized))) throw new Error(`TPEX_TW_BOND_INVALID_NUMBER:${field}:${normalized}`);
  return normalized;
}

function integer(value: unknown): number | null {
  const normalized = text(value);
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeTaiwanGovernmentBond(
  raw: TaiwanGovernmentBondRaw,
  snapshotDate: string,
): NormalizedTaiwanGovernmentBond {
  const officialSecurityId = text(raw.BondCode);
  const issuerCode = text(raw.IssuerCode);
  const issuerName = text(raw.IssuerName);
  const issueDate = yyyymmdd(raw.IssueDate, "IssueDate")!;
  const maturityDate = yyyymmdd(raw.MaturityDate, "MaturityDate")!;
  const sourceDate = yyyymmdd(raw.Date, "Date")!;
  if (!officialSecurityId) throw new Error("TPEX_TW_BOND_CODE_REQUIRED");
  if (!issuerCode || !issuerName) throw new Error(`TPEX_TW_BOND_ISSUER_REQUIRED:${officialSecurityId}`);
  if (issueDate > maturityDate) throw new Error(`TPEX_TW_BOND_DATE_ORDER_INVALID:${officialSecurityId}`);
  const status = issueDate > snapshotDate ? "ANNOUNCED" : maturityDate < snapshotDate ? "MATURED" : "ACTIVE";
  return {
    sourceNamespace: TAIWAN_GOVERNMENT_BOND_SOURCE_NAMESPACE,
    officialSecurityId,
    issuerCode,
    issuerName,
    name: nullableText(raw.ShortName) ?? `Taiwan Government Bond ${officialSecurityId}`,
    country: "TW",
    currency: "TWD",
    bondType: "GOVERNMENT_BOND",
    seriesNumber: nullableText(raw.SeriesNumber),
    trancheNumber: nullableText(raw.TrancheNumber),
    issueDate,
    maturityDate,
    listingDate: yyyymmdd(raw.ListingDate, "ListingDate", false),
    issueAmount: decimal(raw.IssueAmount, "IssueAmount"),
    outstandingAmount: decimal(raw.OutstandingAmount, "OutstandingAmount"),
    couponRate: decimal(raw.CouponRate, "CouponRate"),
    couponType: "FIXED",
    couponFrequency: integer(raw.CouponFrequency),
    paymentFrequency: integer(raw.PaidFrequency),
    tenorYears: integer(raw.TenorYear),
    tenorMonths: integer(raw.TenorMonth),
    listingStatusCode: text(raw.ListingStatus),
    sourceDate,
    sourcePayloadHash: sha256(JSON.stringify(raw)),
    status,
  };
}

export class TaiwanGovernmentBondAdapter {
  readonly sourceNamespace = TAIWAN_GOVERNMENT_BOND_SOURCE_NAMESPACE;
  readonly endpoint = TAIWAN_GOVERNMENT_BOND_ENDPOINT;
  private readonly options: { timeoutMs?: number; maxRetries?: number; userAgent?: string };

  constructor(options: { timeoutMs?: number; maxRetries?: number; userAgent?: string } = {}) {
    this.options = options;
  }

  async fetch(): Promise<{ document: TaiwanGovernmentBondSourceDocument; bonds: TaiwanGovernmentBondRaw[] }> {
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const maxRetries = this.options.maxRetries ?? 4;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetch(this.endpoint, {
          headers: {
            Accept: "application/json",
            "User-Agent": this.options.userAgent ?? process.env.SMARTFUND_DATA_USER_AGENT ?? "SmartFund/1.0 official-data adapter",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`TPEX_TW_BOND_HTTP_${response.status}`);
        const rawText = await response.text();
        const payload = JSON.parse(rawText) as TaiwanGovernmentBondRaw[];
        if (!Array.isArray(payload) || payload.length === 0) throw new Error("TPEX_TW_BOND_EMPTY_RESPONSE");
        const sourceDates = payload.map((row) => yyyymmdd(row.Date, "Date")!).sort();
        const fetchedAt = new Date().toISOString();
        return {
          document: {
            sourceNamespace: TAIWAN_GOVERNMENT_BOND_SOURCE_NAMESPACE,
            sourceDocumentId: `bond_ISSBD1_data:${sourceDates.at(-1)}`,
            requestUrl: this.endpoint,
            fetchedAt,
            sourceDate: sourceDates.at(-1) ?? null,
            contentHash: sha256(rawText),
            recordCount: payload.length,
            rawText,
          },
          bonds: payload,
        };
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
