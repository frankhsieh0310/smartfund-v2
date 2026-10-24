// Same shadow-mode pattern as every other write gate this round -- default OFF, only the exact
// string "on" opens it.
export function isYahooFundamentalsSyncWriteEnabled(): boolean {
  return process.env.YAHOO_FUNDAMENTALS_SYNC_WRITE === "on";
}
