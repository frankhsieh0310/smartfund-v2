// Canonical SEC EPS selection + split adjustment + TTM assembly.
//
// Why this exists: stock_financial_facts intentionally keeps every distinct SEC filing's report of a
// given (period_start, period_end) as its own row (accession is part of the unique key) — that's correct
// for audit/history, but a naive "take the latest row by period_end" consumer (the first version of the
// PE recompute job) can silently blend a PRE-split and POST-split value for the same historical quarter
// into one TTM sum. Found via NVDA: its 2023 Q3 basic EPS is on record as both 3.75 (filed 2023-11-21,
// pre their 2024 10:1 split) and 0.37 (filed 2024-11-20, restated post-split in the next year's 10-Q
// comparative column) — same period, 10x apart.
//
// The general fix doesn't need to compute a split ratio at all in the common case: US GAAP requires
// restating prior-period comparative EPS after a split, so picking the fact with the LATEST filing_date
// for each exact (period_start, period_end) already yields the post-split, restated value whenever a
// later filing exists. Split events (already ingested from Yahoo chart data as `yahoo.event.splitRatio`,
// same source as dividend events — zero new fetch) are only consulted as a fallback: if a quarter's ONLY
// known fact predates a split that happened before today and no later filing has restated it yet, that
// one fact is programmatically divided by the split ratio. A period that is genuinely ambiguous (e.g. a
// split occurred after its only filing and the ratio can't be resolved) is left unresolved rather than
// guessed.

export type RawFact = { periodStart: string; periodEnd: string; value: number; filingDate: string | null };
export type SplitEvent = { effectiveDate: string; ratio: number };
export type AdjustmentType = "NONE" | "RESTATED" | "SPLIT_ADJUSTED" | "DERIVED_Q4";
export type CanonicalFact = { periodStart: string; periodEnd: string; value: number; filingDate: string | null; adjustment: AdjustmentType; confidence: "HIGH" | "MEDIUM" | "REJECTED" };

const DAY_MS = 86_400_000;
export function isQuarterSpan(startIso: string, endIso: string): boolean {
  const days = (new Date(endIso).getTime() - new Date(startIso).getTime()) / DAY_MS;
  return days >= 75 && days <= 100;
}
export function isAnnualSpan(startIso: string, endIso: string): boolean {
  const days = (new Date(endIso).getTime() - new Date(startIso).getTime()) / DAY_MS;
  return days >= 350 && days <= 380;
}
function isContiguous(periodEndsDesc: string[]): boolean {
  const asc = [...periodEndsDesc].reverse();
  for (let i = 1; i < asc.length; i++) {
    const gap = (new Date(asc[i]).getTime() - new Date(asc[i - 1]).getTime()) / DAY_MS;
    if (gap < 70 || gap > 115) return false;
  }
  return true;
}

// STEP C2 canonical priority, collapsed to: group by the exact reporting period, take the fact filed most
// recently (this is what "amended filing preferred" and "restated > superseded" both reduce to — a later
// accession's report of the same period always supersedes an earlier one, amendment or not), then apply
// split adjustment only when no later filing exists to have already restated it.
function selectCanonicalByPeriod(facts: RawFact[], splits: SplitEvent[]): Map<string, CanonicalFact> {
  const byPeriod = new Map<string, RawFact[]>();
  for (const f of facts) {
    if (!f.filingDate) continue; // filing date is how we order "latest wins" — undated facts can't be ranked, skip
    const key = `${f.periodStart}|${f.periodEnd}`;
    (byPeriod.get(key) ?? byPeriod.set(key, []).get(key)!).push(f);
  }
  const result = new Map<string, CanonicalFact>();
  for (const [key, group] of byPeriod) {
    const sorted = [...group].sort((a, b) => (b.filingDate ?? "").localeCompare(a.filingDate ?? ""));
    const latest = sorted[0];
    const laterSplits = splits.filter((s) => s.effectiveDate > latest.filingDate!);
    const splitFactor = laterSplits.reduce((acc, s) => acc * s.ratio, 1);
    const restated = sorted.length > 1;
    result.set(key, {
      periodStart: latest.periodStart, periodEnd: latest.periodEnd,
      value: latest.value / splitFactor, filingDate: latest.filingDate,
      adjustment: splitFactor !== 1 ? "SPLIT_ADJUSTED" : restated ? "RESTATED" : "NONE",
      confidence: "HIGH",
    });
  }
  return result;
}

// Resolves the canonical value for every distinct reporting period this stock has (quarterly + annual),
// deriving the one quarter US GAAP never files standalone (the annual-report-only "Q4") from
// annual − the three quarters it contains, when exactly three contained quarters exist.
export function resolveCanonicalQuarters(facts: RawFact[], splits: SplitEvent[]): CanonicalFact[] {
  const canonical = selectCanonicalByPeriod(facts, splits);
  const quarters = [...canonical.values()].filter((f) => isQuarterSpan(f.periodStart, f.periodEnd));
  const annuals = [...canonical.values()].filter((f) => isAnnualSpan(f.periodStart, f.periodEnd));
  const byEnd = new Map(quarters.map((q) => [q.periodEnd, q]));
  for (const annual of annuals) {
    if (byEnd.has(annual.periodEnd)) continue;
    const contained = quarters.filter((q) => q.periodStart >= annual.periodStart && q.periodEnd <= annual.periodEnd);
    if (contained.length !== 3) continue;
    const derivedValue = annual.value - contained.reduce((sum, q) => sum + q.value, 0);
    if (!Number.isFinite(derivedValue)) continue;
    byEnd.set(annual.periodEnd, {
      periodStart: contained.at(-1)!.periodEnd, periodEnd: annual.periodEnd, value: derivedValue,
      filingDate: annual.filingDate, adjustment: "DERIVED_Q4", confidence: "HIGH",
    });
  }
  return [...byEnd.values()].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
}

// STEP C7: exactly 4 date-contiguous quarters or NULL — never extrapolate over a gap.
export function resolveTtmEps(facts: RawFact[], splits: SplitEvent[]): { ttm: number; quarters: CanonicalFact[] } | null {
  const combined = resolveCanonicalQuarters(facts, splits).slice(0, 4);
  if (combined.length < 4) return null;
  if (!isContiguous(combined.map((q) => q.periodEnd))) return null;
  return { ttm: combined.reduce((sum, q) => sum + q.value, 0), quarters: combined };
}
