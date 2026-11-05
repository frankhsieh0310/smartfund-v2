export function isFundclearOffshoreAnnualWriteEnabled(): boolean {
  return process.env.FUNDCLEAR_OFFSHORE_ANNUAL_WRITE?.trim() === "on";
}
