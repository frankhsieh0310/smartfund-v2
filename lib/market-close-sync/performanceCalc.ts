// Task P: pure return-calculation helpers for etf_performances recompute. DB I/O lives in
// priceWriter.ts; this file is deliberately DB-free so the math is trivially unit-testable.
//
// Return definition, per task spec: "目標日當天或之前最後一筆收盤價" (the last close ON OR BEFORE
// the target date) is always the TARGET side of the calculation; the BASE side for each period is
// "目標日 minus N days 當天或之前最後一筆收盤價" — the last close on or before (targetDate - period).

export type PerformancePeriod = "1D" | "1M" | "3M" | "6M" | "1Y" | "3Y";

export const PERFORMANCE_PERIODS: PerformancePeriod[] = ["1D", "1M", "3M", "6M", "1Y", "3Y"];

// Calendar-day approximations for each period, matching how every other return field in this
// codebase (EtfPerformance's own return_1m/return_3m/etc.) is already computed — not trading-day
// counts.
export const PERFORMANCE_PERIOD_DAYS: Record<PerformancePeriod, number> = {
  "1D": 1,
  "1M": 30,
  "3M": 91,
  "6M": 182,
  "1Y": 365,
  "3Y": 1095,
};

export function baseDateFor(targetLocalDate: string, periodDays: number): string {
  const d = new Date(`${targetLocalDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - periodDays);
  return d.toISOString().slice(0, 10);
}

/** A fractional return, or null when there's no base close to compare against (e.g. the ETF's
 * history doesn't go back far enough for a 3Y return yet) — never a fabricated 0. */
export function computeReturn(targetClose: number, baseClose: number | null): number | null {
  if (baseClose == null || baseClose === 0) return null;
  return (targetClose - baseClose) / baseClose;
}
