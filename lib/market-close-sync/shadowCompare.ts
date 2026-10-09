// Pure classification logic — shadow mode never writes etf_history/etf_performance/etfs, it only
// decides which bucket a (DB row, Spark candle) pair falls into so the route can count and log it.

import type { ShadowClassification } from "./types";

const PRICE_EPSILON = 1e-6; // float-compare tolerance for "same" close

export function classify(input: {
  dbDate: string | null; // etfs.price_updated_at, "YYYY-MM-DD" (already date-only)
  dbClose: number | null; // etfs.latest_price
  sparkDate: string | null; // local-date-aligned target date, or null if Spark had nothing for it
  sparkClose: number | null;
}): ShadowClassification {
  const { dbDate, dbClose, sparkDate, sparkClose } = input;

  if (sparkDate == null || sparkClose == null) return "SOURCE_MISSING";
  if (dbDate == null || dbClose == null) return "NEW";
  if (dbDate > sparkDate) return "DB_NEWER";
  if (Math.abs(dbClose - sparkClose) <= PRICE_EPSILON && dbDate === sparkDate) return "SAME";
  return "CHANGED";
}
