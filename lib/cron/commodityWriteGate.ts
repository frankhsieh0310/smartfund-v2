// Task X9: same shadow-mode pattern as lib/etf-returns-sync/writeGate.ts and
// lib/market-close-sync/writeGate.ts — default OFF, only the exact string "on" opens it, a
// near-miss value never falls open. This pipeline (restored from the dormant release-data-p3
// branch) originally had NO write gate at all; added here before any deploy, per the user's
// explicit round-5 instruction to shadow-run and spot-check before writing.
export function isCommoditySyncWriteEnabled(): boolean {
  return process.env.COMMODITY_SYNC_WRITE === "on";
}
