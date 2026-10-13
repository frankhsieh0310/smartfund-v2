import type { FreshnessStatus } from "./types.ts";

export type FreshnessPolicy = "MARKET_DAY" | "PUBLICATION_AWARE" | "CONTINUOUS";

function latestCompletedBusinessDay(now: Date): Date {
  const result = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = result.getUTCDay();
  if (day === 0) result.setUTCDate(result.getUTCDate() - 2);
  if (day === 6) result.setUTCDate(result.getUTCDate() - 1);
  return result;
}

export function freshnessStatus(asOf: Date | null | undefined, policy: FreshnessPolicy, now = new Date()): FreshnessStatus {
  if (!asOf) return "UNKNOWN";
  const ageMs = now.getTime() - asOf.getTime();
  if (policy === "PUBLICATION_AWARE") return ageMs <= 45 * 86_400_000 ? "HEALTHY_WAITING" : "STALE";
  if (policy === "CONTINUOUS") return ageMs <= 24 * 3_600_000 ? "CURRENT" : "STALE";
  return asOf.getTime() >= latestCompletedBusinessDay(now).getTime() ? "CURRENT" : "STALE";
}
