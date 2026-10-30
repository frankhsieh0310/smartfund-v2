export function isEtfPremiumDiscountSyncWriteEnabled(): boolean {
  return process.env.ETF_PREMIUM_DISCOUNT_SYNC_WRITE?.trim() === "on";
}
