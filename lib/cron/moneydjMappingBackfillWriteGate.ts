export function isMoneydjMappingBackfillWriteEnabled(): boolean {
  return process.env.MONEYDJ_MAPPING_BACKFILL_WRITE?.trim() === "on";
}
