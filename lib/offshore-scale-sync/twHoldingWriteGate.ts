export function isOffshoreTwHoldingWriteEnabled(): boolean {
  return process.env.OFFSHORE_TW_HOLDING_WRITE?.trim() === "on";
}
