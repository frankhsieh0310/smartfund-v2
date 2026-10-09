export type BasisUnit = "BASIS_POINTS";
export type BasisQuoteType = "MID" | "BID" | "ASK" | "FIXING" | "CLOSE" | "INDICATIVE" | "EOD" | "OTHER";
export type VerificationStatus = "PENDING" | "VERIFIED" | "REJECTED" | "LICENSE_BLOCKED" | "AUTH_BLOCKED" | "TERMS_REVIEW_REQUIRED";
export type QualityStatus = "PENDING" | "PASS" | "WARNING" | "REJECTED";
export type FreshnessStatus = "CURRENT" | "DELAYED" | "STALE" | "SOURCE_DELAYED" | "LICENSE_BLOCKED" | "SOURCE_PENDING" | "UNKNOWN";

export interface CrossCurrencyBasisInstrumentContract {
  basisInstrumentId: string;
  baseCurrencyId: string;
  quoteCurrencyId: string;
  canonicalPair: string;
  tenor: string;
  tenorDaysOrMonths: number | null;
  payLegCurrency: string;
  receiveLegCurrency: string;
  payLegBenchmark: string;
  receiveLegBenchmark: string;
  basisAppliedToLeg: string;
  quoteConvention: string;
  signConvention: string;
  unit: BasisUnit;
  dayCountPayLeg: string | null;
  dayCountReceiveLeg: string | null;
  resetFrequencyPayLeg: string | null;
  resetFrequencyReceiveLeg: string | null;
  marketConventionVersion: string | null;
  status: "ACTIVE" | "DISCONTINUED" | "PENDING";
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceId: string;
  verificationStatus: VerificationStatus;
}

export interface CrossCurrencyBasisObservationContract {
  basisInstrumentId: string;
  observationDateTime: string;
  observationDate: string;
  basisBps: number;
  bidBps: number | null;
  askBps: number | null;
  midBps: number | null;
  rawValue: number;
  rawUnit: string;
  quoteType: BasisQuoteType;
  sourceId: string;
  sourceRecordId: string | null;
  asOfDateTime: string;
  retrievedAt: string;
  verificationStatus: VerificationStatus;
  qualityStatus: QualityStatus;
  checksum: string | null;
}

export interface CrossCurrencyBasisCoverageContract {
  pair: string;
  tenor: string;
  identityReady: boolean;
  directSourceAvailable: boolean;
  licenseStatus: string;
  currentReady: boolean;
  historyReady: boolean;
  historyCount: number;
  firstDate: string | null;
  latestDate: string | null;
  benchmarkLegsReady: boolean;
  quoteConventionReady: boolean;
  provenanceReady: boolean;
  freshnessStatus: FreshnessStatus;
  analyticsReady: boolean;
  missingReasons: string[];
}

export interface CrossCurrencyBasisDetailContract {
  pair: string;
  tenor: string;
  basisBps: number | null;
  benchmarkLegs: { pay: string; receive: string } | null;
  quoteConvention: string | null;
  signConvention: string | null;
  latest: CrossCurrencyBasisObservationContract | null;
  history: CrossCurrencyBasisObservationContract[];
  changeBps: Record<string, number | null>;
  curve: Array<{ tenor: string; basisBps: number }>;
  source: { id: string; asOfDateTime: string; retrievedAt: string } | null;
  freshness: FreshnessStatus;
  quality: QualityStatus;
  missingReasons: string[];
}

export interface CrossCurrencyBasisSearchContract {
  pair: string;
  baseCurrency: string;
  quoteCurrency: string;
  tenor: string;
  benchmarkLegs: { pay: string; receive: string };
  status: string;
}

export interface CrossCurrencyBasisCompareContract {
  pair: string;
  tenor: string;
  basisBps: number;
  benchmarkLegs: { pay: string; receive: string };
  signConvention: string;
  asOfDate: string;
}
