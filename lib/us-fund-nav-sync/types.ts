// Task Y: US mutual-fund NAV sync via Yahoo Spark (same client/date-math market-close-sync already
// proved live — lib/market-close-sync/sparkClient.ts + marketTime.ts + priceSanity.ts, imported
// read-only, never modified). A brand-new pipeline/file; does not touch yahoo-fund-full-sweep.

export type FundNavCandidate = { fundId: string; symbol: string; date: string; nav: number };
