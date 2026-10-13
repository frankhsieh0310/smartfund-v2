// Task X5 Part A: parses Yahoo's fundPerformance.trailingReturns into TrailingReturns.
//
// Yahoo never omits a trailingReturns field when data is unavailable — it returns a literal
// {raw: 0, fmt: "0.00%"} placeholder instead (VERIFIED live against BTC2.AS/LQDM). Yahoo gives no
// flag to distinguish that placeholder from a genuine 0% return, so two rules (user-approved) stand
// in for one:
//   1. When asOfDate itself is epoch (raw 0, fmt "1970-01-01"), the whole trailingReturns block is
//      unpopulated — every period is null.
//   2. Otherwise, any individual period whose own raw value is exactly 0 is treated as unavailable
//      and written null, since a real return landing on exactly 0.0000% is far less likely than
//      Yahoo's placeholder, and showing "no data" is a safer failure mode than a fabricated 0%.
import { rawNum } from "../yahoo/productSession.ts";
import type { TrailingReturns } from "./types.ts";

export function parseTrailingReturns(result: any): TrailingReturns {
  const t = result?.fundPerformance?.trailingReturns ?? {};
  const asOfDateRaw = rawNum(t.asOfDate);
  if (asOfDateRaw === 0) {
    return { r1d: null, r1m: null, r3m: null, r6m: null, rytd: null, r1y: null, r3y: null, r5y: null };
  }
  const pctOf = (v: any): number | null => {
    const raw = rawNum(v);
    if (raw == null || raw === 0) return null;
    // Same convention as the existing Yahoo ETF enrichment pipeline: a fmt string containing "%", or
    // a raw magnitude small enough to plausibly be a fraction (<=2), is treated as a fraction and
    // scaled to percent units; otherwise the raw value is already in percent units.
    const fmt = v && typeof v === "object" && typeof v.fmt === "string" ? v.fmt : "";
    return fmt.includes("%") || Math.abs(raw) <= 2 ? raw * 100 : raw;
  };
  return {
    r1d: pctOf(t.oneDay), r1m: pctOf(t.oneMonth), r3m: pctOf(t.threeMonth), r6m: pctOf(t.sixMonth),
    rytd: pctOf(t.ytd), r1y: pctOf(t.oneYear), r3y: pctOf(t.threeYear), r5y: pctOf(t.fiveYear),
  };
}
