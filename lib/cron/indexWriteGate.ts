// Task X9: same shadow-mode pattern as lib/cron/commodityWriteGate.ts and
// lib/etf-returns-sync/writeGate.ts — default OFF, only the exact string "on" opens it. This
// pipeline (restored from the dormant release-data-p3 branch) originally had NO write gate at all.
export function isIndexSyncWriteEnabled(): boolean {
  return process.env.INDEX_SYNC_WRITE === "on";
}
