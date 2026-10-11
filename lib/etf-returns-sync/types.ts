// Task X: ETF return percentages, sourced verbatim from Yahoo's own quoteSummary fundPerformance
// module — this feature never computes a return itself (that was market-close-sync's old, now-
// removed approach, confirmed this session to diverge significantly from Yahoo's own numbers,
// especially for 3Y/5Y which Yahoo reports ANNUALIZED, not cumulative).

export type TrailingReturns = {
  r1d: number | null;
  r1m: number | null;
  r3m: number | null;
  r6m: number | null;
  rytd: number | null;
  r1y: number | null;
  r3y: number | null; // annualized (CAGR), per Yahoo's own convention — confirmed live this session
  r5y: number | null; // annualized (CAGR), same convention as r3y
};

export type EtfReturnsCandidate = {
  etfId: string;
  symbol: string;
  date: string; // the date this sync ran, YYYY-MM-DD — matches the existing Yahoo enrichment
  // pipeline's own convention (etfEnrich.ts writes "today", not a Yahoo-provided as-of date)
  returns: TrailingReturns;
};
