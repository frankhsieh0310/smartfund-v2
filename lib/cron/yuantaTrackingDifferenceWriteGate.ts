export function isYuantaTrackingDifferenceSyncWriteEnabled(): boolean {
  return process.env.YUANTA_TRACKING_DIFFERENCE_SYNC_WRITE?.trim() === "on";
}
