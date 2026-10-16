// Same shadow-mode pattern as the other write gates this round -- default OFF, only the exact
// string "on" opens it. Per instruction: left off until the final consolidated deploy.
export function isStockTechnicalSyncWriteEnabled(): boolean {
  return process.env.STOCK_TECHNICAL_SYNC_WRITE === "on";
}
