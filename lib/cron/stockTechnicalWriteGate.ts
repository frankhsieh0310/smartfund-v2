// Same shadow-mode pattern as the other write gates this round -- default OFF, only the exact
// string "on" opens it. Per instruction: left off until the final consolidated deploy.
export function isStockTechnicalSyncWriteEnabled(): boolean {
  return process.env.STOCK_TECHNICAL_SYNC_WRITE === "on";
}

// 2026-10-24（選股反查第一階段：技術指標擴充到美股）: 獨立的 write gate，先 shadow mode 驗證
// US stale-stock 掃描與計算邏輯正確，再由使用者核准開啟真正寫入——跟 TW 那組 gate 分開，互不
//影響，TW 已經在正常運作的每日更新不會被這次改動打斷。
export function isStockTechnicalSyncWriteEnabledUs(): boolean {
  return process.env.STOCK_TECHNICAL_SYNC_WRITE_US === "on";
}
