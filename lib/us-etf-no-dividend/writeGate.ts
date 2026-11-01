export function isUsEtfNoDividendWriteEnabled(): boolean {
  return process.env.US_ETF_NO_DIVIDEND_WRITE?.trim() === "on";
}
