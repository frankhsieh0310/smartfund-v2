export function isFundYahooMappingBackfillWriteEnabled(): boolean {
  return process.env.FUND_YAHOO_MAPPING_BACKFILL_WRITE?.trim() === "on";
}
