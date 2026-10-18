// Same shadow-mode pattern as every other sync job in this codebase -- default OFF, only the exact
// string "on" opens it.
export function isTwPurchasableClassifyWriteEnabled(): boolean {
  return process.env.TW_PURCHASABLE_CLASSIFY_WRITE === "on";
}
