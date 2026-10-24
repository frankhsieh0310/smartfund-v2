export function isGlobalStockPriceSyncWriteEnabled(): boolean {
  return process.env.GLOBAL_STOCK_PRICE_SYNC_WRITE === "on";
}
