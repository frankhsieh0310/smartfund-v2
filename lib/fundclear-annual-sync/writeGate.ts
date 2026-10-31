export function isFundclearAnnualWriteEnabled(): boolean {
  return process.env.FUNDCLEAR_ANNUAL_WRITE?.trim() === "on";
}
