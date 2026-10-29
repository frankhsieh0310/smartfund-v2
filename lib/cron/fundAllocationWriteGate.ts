export function isFundAllocationSyncWriteEnabled(): boolean {
  return process.env.FUND_ALLOCATION_SYNC_WRITE?.trim() === "on";
}
