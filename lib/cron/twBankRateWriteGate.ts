export function isTwBankRateSyncWriteEnabled(): boolean {
  return process.env.TW_BANK_RATE_SYNC_WRITE?.trim() === "on";
}
