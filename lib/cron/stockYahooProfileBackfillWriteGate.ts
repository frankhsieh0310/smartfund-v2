export function isStockYahooProfileBackfillWriteEnabled(): boolean {
  return process.env.STOCK_YAHOO_PROFILE_BACKFILL_WRITE === "on";
}
