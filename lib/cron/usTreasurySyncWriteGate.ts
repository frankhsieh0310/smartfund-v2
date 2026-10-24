export function isUsTreasurySyncWriteEnabled(): boolean {
  return process.env.US_TREASURY_SYNC_WRITE === "on";
}
