// Shadow mode by default. Separate switch from OFFSHORE_NAV_SYNC_WRITE/OFFSHORE_NAV_TDCC_SYNC_WRITE
// — the daily top-up and the one-time historical backfill are independent write decisions.
export function isBackfillWriteEnabled(): boolean {
  return process.env.FUND_HISTORY_BACKFILL_WRITE?.trim() === "on";
}
