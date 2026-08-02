import type { NormalizedTaiwanGovernmentBond } from "./TaiwanGovernmentBondAdapter.ts";

export const TAIWAN_GOVERNMENT_BOND_FRESHNESS_VALIDATOR_VERSION = "1.0.0";

export type TaiwanBondFreshnessStatus =
  | "FRESH"
  | "STALE"
  | "FUTURE_ANNOUNCEMENT"
  | "MATURED"
  | "ANNOUNCED_NOT_ISSUED"
  | "NO_MARKET_PRICE_SOURCE"
  | "SOURCE_DELAYED"
  | "UNKNOWN";

export type TaiwanBondFreshnessLayer =
  | "UNIVERSE"
  | "TERMS"
  | "ISSUANCE_LIFECYCLE"
  | "LATEST_OFFICIAL_SNAPSHOT"
  | "OUTSTANDING_AMOUNT"
  | "SECONDARY_MARKET_PRICE";

export type TaiwanBondFreshnessRecord = {
  officialSecurityId: string;
  layer: TaiwanBondFreshnessLayer;
  expectedUpdateDate: string;
  latestSourceDate: string | null;
  latestActualObservationDate: string | null;
  staleDays: number | null;
  freshnessStatus: TaiwanBondFreshnessStatus;
  freshnessReason: string;
  validatorVersion: string;
};

function previousWeekday(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  while (value.getUTCDay() === 0 || value.getUTCDay() === 6) value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function daysBetween(later: string, earlier: string): number {
  return Math.max(0, Math.floor((Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / 86_400_000));
}

function officialStatus(bond: NormalizedTaiwanGovernmentBond, expectedUpdateDate: string): {
  status: TaiwanBondFreshnessStatus;
  staleDays: number;
  reason: string;
} {
  if (bond.status === "MATURED") return { status: "MATURED", staleDays: 0, reason: "BOND_MATURED" };
  if (bond.status === "ANNOUNCED") return { status: "ANNOUNCED_NOT_ISSUED", staleDays: 0, reason: "ISSUE_DATE_IS_IN_THE_FUTURE" };
  const staleDays = daysBetween(expectedUpdateDate, bond.sourceDate);
  return staleDays === 0
    ? { status: "FRESH", staleDays, reason: "TPEX_SOURCE_SNAPSHOT_MEETS_EXPECTED_BUSINESS_DATE" }
    : { status: "STALE", staleDays, reason: "TPEX_SOURCE_SNAPSHOT_OLDER_THAN_EXPECTED_BUSINESS_DATE" };
}

export function buildTaiwanGovernmentBondFreshnessLedger(
  bonds: NormalizedTaiwanGovernmentBond[],
  snapshotDate: string,
): TaiwanBondFreshnessRecord[] {
  const expectedUpdateDate = previousWeekday(snapshotDate);
  const records: TaiwanBondFreshnessRecord[] = [];
  for (const bond of bonds) {
    const official = officialStatus(bond, expectedUpdateDate);
    const base = {
      officialSecurityId: bond.officialSecurityId,
      expectedUpdateDate,
      latestSourceDate: bond.sourceDate,
      latestActualObservationDate: bond.sourceDate,
      staleDays: official.staleDays,
      freshnessStatus: official.status,
      validatorVersion: TAIWAN_GOVERNMENT_BOND_FRESHNESS_VALIDATOR_VERSION,
    };
    records.push(
      { ...base, layer: "UNIVERSE", freshnessReason: official.reason },
      { ...base, layer: "TERMS", freshnessReason: official.reason },
      { ...base, layer: "ISSUANCE_LIFECYCLE", latestActualObservationDate: bond.issueDate, freshnessReason: bond.status === "ANNOUNCED" ? "ANNOUNCED_NOT_ISSUED" : "ISSUE_AND_MATURITY_DATES_AVAILABLE" },
      { ...base, layer: "LATEST_OFFICIAL_SNAPSHOT", freshnessReason: official.reason },
      { ...base, layer: "OUTSTANDING_AMOUNT", freshnessReason: official.reason },
      {
        ...base,
        layer: "SECONDARY_MARKET_PRICE",
        latestSourceDate: null,
        latestActualObservationDate: null,
        staleDays: null,
        freshnessStatus: "UNKNOWN",
        freshnessReason: "SECONDARY_MARKET_SOURCE_NOT_YET_CONNECTED",
      },
    );
  }
  return records;
}
