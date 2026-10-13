// Task Y Part B.2 (user-approved): shadow mode by default. Deliberately a separate env var from
// MARKET_CLOSE_SYNC_WRITE / ETF_RETURNS_SYNC_WRITE — the three pipelines' write switches never
// interact, same pattern established for etf-returns-sync vs market-close-sync.
export function isWriteEnabled(): boolean {
  return process.env.FUND_NAV_SYNC_WRITE === "on";
}

export type RunMode = "SHADOW" | "WRITE";
export function currentRunMode(): RunMode {
  return isWriteEnabled() ? "WRITE" : "SHADOW";
}
