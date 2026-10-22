// Same shadow-mode pattern as lib/cron/indexWriteGate.ts and commodityWriteGate.ts — default OFF,
// only the exact string "on" opens real writes. 2026-10-22 (使用者核准第二項): ported from the
// orphaned local-only script scripts/data/money-market/run-global-money-market.ts, which had no
// write gate, no cloud cron, and never reported to production_scheduler_runs at all.
export function isMoneyMarketWriteEnabled(): boolean {
  return process.env.MONEY_MARKET_RATES_WRITE === "on";
}
