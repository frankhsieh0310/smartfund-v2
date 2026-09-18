// Shared holdings-depth classification. Derived entirely from data already on disk (source label +
// row count) — no schema change. Different providers disclose different depths for the same kind of
// "holdings" data (Yahoo/MoneyDJ public: Top 10 only; Taiwan broker pages: a partial list, commonly
// 29-170 rows; SEC N-PORT: the fund's/ETF's complete regulatory portfolio) and nothing upstream
// currently records which one a given row came from — this makes that explicit and queryable.

export type CoverageDepth = "TOP_N" | "PARTIAL" | "FULL" | "UNKNOWN";

export type HoldingsCoverage = {
  coverage_depth: CoverageDepth;
  is_full_holdings: boolean;
  holding_count: number | null;
  source: string | null;
};

// Sources known to disclose a complete, regulatory-grade portfolio (not a top-N excerpt).
const FULL_DISCLOSURE_SOURCES = new Set(["SEC_EDGAR_NPORT", "SEC_EDGAR_NPORT_P"]);

// A disclosed-holdings "scope" already computed at parse time for some sources (e.g. MoneyDJ fund
// disclosure) — reuse it directly instead of re-deriving from row count when it's available.
export type KnownDisclosureScope = "TOP_10_DISCLOSED" | "TOP_5_DISCLOSED" | "OTHER_PARTIAL_DISCLOSURE" | null | undefined;

export function classifyHoldingsCoverage(input: {
  source: string | null;
  holdingCount: number | null;
  disclosureScope?: KnownDisclosureScope;
}): HoldingsCoverage {
  const { source, holdingCount, disclosureScope } = input;

  if (source && FULL_DISCLOSURE_SOURCES.has(source)) {
    return { coverage_depth: "FULL", is_full_holdings: true, holding_count: holdingCount, source };
  }

  if (disclosureScope === "TOP_10_DISCLOSED" || disclosureScope === "TOP_5_DISCLOSED") {
    return { coverage_depth: "TOP_N", is_full_holdings: false, holding_count: holdingCount, source };
  }
  if (disclosureScope === "OTHER_PARTIAL_DISCLOSURE") {
    return { coverage_depth: "PARTIAL", is_full_holdings: false, holding_count: holdingCount, source };
  }

  if (holdingCount == null) {
    return { coverage_depth: "UNKNOWN", is_full_holdings: false, holding_count: null, source };
  }
  // Yahoo quoteSummary / MoneyDJ's own "public" ETF holdings endpoint both cap at 10 rows in every
  // sample observed this round (avg 8, max 10) — a row count at or below that ceiling is a top-N
  // excerpt, not a claim of completeness.
  if (holdingCount <= 10) {
    return { coverage_depth: "TOP_N", is_full_holdings: false, holding_count: holdingCount, source };
  }
  // Above the top-10 ceiling but from a source not confirmed as full-regulatory-disclosure (e.g. the
  // Taiwan broker pages, observed 29-170 rows) — broader than a top-10 excerpt, but not provably the
  // fund's/ETF's entire portfolio either, so PARTIAL rather than assuming FULL.
  return { coverage_depth: "PARTIAL", is_full_holdings: false, holding_count: holdingCount, source };
}
