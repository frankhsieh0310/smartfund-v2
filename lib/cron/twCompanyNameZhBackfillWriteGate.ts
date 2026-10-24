export function isTwCompanyNameZhBackfillWriteEnabled(): boolean {
  return process.env.TW_COMPANY_NAME_ZH_BACKFILL_WRITE === "on";
}
