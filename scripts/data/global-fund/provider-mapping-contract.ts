export const FUND_MAPPING_METHODS = [
  "EXACT_ISIN",
  "EXACT_LOCAL_CODE",
  "EXACT_PROVIDER_ID",
  "EXACT_SEC_SERIES_ID",
  "EXACT_SEC_CLASS_ID",
  "DETERMINISTIC_COMPOSITE",
  "LEGACY_UNVERIFIED",
] as const;

export type FundMappingMethod = (typeof FUND_MAPPING_METHODS)[number];

const fundMappingMethods = new Set<string>(FUND_MAPPING_METHODS);

export function parseFundMappingMethod(value: string | null | undefined): FundMappingMethod {
  if (value == null) return "LEGACY_UNVERIFIED";
  if (!fundMappingMethods.has(value)) throw new Error(`INVALID_FUND_MAPPING_METHOD:${value}`);
  return value as FundMappingMethod;
}

export function assertVerifiedFundMapping(input: {
  source: string | null | undefined;
  mappingMethod: string | null | undefined;
  verifiedAt: Date | null | undefined;
}) {
  const mappingMethod = parseFundMappingMethod(input.mappingMethod);
  if (mappingMethod === "LEGACY_UNVERIFIED") throw new Error("FUND_MAPPING_NOT_VERIFIED");
  if (!input.source?.trim()) throw new Error("FUND_MAPPING_SOURCE_REQUIRED");
  if (!(input.verifiedAt instanceof Date) || Number.isNaN(input.verifiedAt.getTime())) {
    throw new Error("FUND_MAPPING_VERIFIED_AT_REQUIRED");
  }
  return mappingMethod;
}
