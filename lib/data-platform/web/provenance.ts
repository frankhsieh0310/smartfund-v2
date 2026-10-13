import type { Provenance } from "./types.ts";
import { isoOrNull } from "./types.ts";

function sourceType(source: string | null): Provenance["sourceType"] {
  if (!source) return "UNKNOWN";
  if (/SEC|FRED|ECB|TWSE|TPEX|JPX|OFFICIAL/i.test(source)) return "OFFICIAL";
  if (/YAHOO|MARKET/i.test(source)) return "APPROVED_MARKET_DATA";
  return "VERIFIED_PROVIDER";
}

export function buildProvenance(input: {
  source?: string | null;
  sourceRecordId?: string | null;
  asOfDate?: Date | string | null;
  lastUpdated?: Date | string | null;
}): Provenance {
  const source = input.source ?? null;
  return {
    source,
    sourceType: sourceType(source),
    sourceRecordId: input.sourceRecordId ?? null,
    asOfDate: isoOrNull(input.asOfDate),
    lastUpdated: isoOrNull(input.lastUpdated),
    provenanceStatus: source ? "VERIFIED" : "SOURCE_NOT_EXPOSED",
  };
}
