export function isOffshoreDividendTdccWriteEnabled(): boolean {
  return process.env.OFFSHORE_DIVIDEND_TDCC_WRITE === "on";
}
