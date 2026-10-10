// Pure classification logic — shadow mode never writes etf_history/etf_performance/etfs, it only
// decides which bucket a (DB row, Spark candle) pair falls into so the route can count and log it.
//
// Task J change: "DB has this trading day" is now answered by looking up an actual etf_history row
// for the target LOCAL date (converted through the market's own timezone — see route.ts), not by
// naively string-slicing etfs.price_updated_at. That field's underlying convention turned out to be
// a UTC instant equal to the target market's LOCAL midnight (confirmed via a live weekend-date
// anomaly this round — see DATE_CONVENTION_FINDING in the task report), so `.toISOString().slice(0,
// 10)` on it silently returns the wrong calendar day for any non-UTC market. classify() itself is
// unaware of that fix; it only ever sees already-correctly-localized date strings from its caller.
//
// SOURCE_MISSING is now split from NO_BAR_FOR_TARGET_DATE: the former means Spark's own result array
// had no entry at all for the symbol (dead/delisted/unknown ticker); the latter means Spark had the
// symbol with real candles, just none landing on the target date (e.g. a same-day publication lag).
// Collapsing these hid the real cause of this round's abnormally high "SOURCE_MISSING" counts.

import type { ShadowClassification } from "./types";

const PRICE_EPSILON = 1e-6; // float-compare tolerance for "same" close

export function classify(input: {
  dbDate: string | null; // DB's own local trading date for this etf_id, already timezone-resolved by the caller — null if no etf_history row found near the target
  dbClose: number | null;
  sparkSymbolPresent: boolean; // false => Spark's result array had no entry at all for this symbol
  sparkDate: string | null; // the target date IF Spark had a matching candle for it, else null
  sparkClose: number | null;
}): ShadowClassification {
  const { dbDate, dbClose, sparkSymbolPresent, sparkDate, sparkClose } = input;

  if (!sparkSymbolPresent) return "SOURCE_MISSING";
  if (sparkDate == null || sparkClose == null) return "NO_BAR_FOR_TARGET_DATE";
  if (dbDate == null || dbClose == null) return "NEW";
  if (dbDate > sparkDate) return "DB_NEWER";
  if (Math.abs(dbClose - sparkClose) <= PRICE_EPSILON && dbDate === sparkDate) return "SAME";
  return "CHANGED";
}
