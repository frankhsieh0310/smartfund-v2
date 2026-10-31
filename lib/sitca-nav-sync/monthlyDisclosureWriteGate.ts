// Shadow mode by default for both. Separate from SITCA_NAV_SYNC_WRITE — the daily NAV sync and this
// once-a-month fee/AUM disclosure ingestion are independent write switches.
export function isFeeDisclosureWriteEnabled(): boolean {
  return process.env.SITCA_FEE_DISCLOSURE_WRITE?.trim() === "on";
}

export function isAumDisclosureWriteEnabled(): boolean {
  return process.env.SITCA_AUM_DISCLOSURE_WRITE?.trim() === "on";
}
