// Shadow mode by default. A separate env var from FUND_NAV_SYNC_WRITE/MARKET_CLOSE_SYNC_WRITE/
// ETF_RETURNS_SYNC_WRITE — none of these pipelines' write switches interact.
export function isWriteEnabled(): boolean {
  return process.env.SITCA_NAV_SYNC_WRITE === "on";
}

export type RunMode = "SHADOW" | "WRITE";
export function currentRunMode(): RunMode {
  return isWriteEnabled() ? "WRITE" : "SHADOW";
}
