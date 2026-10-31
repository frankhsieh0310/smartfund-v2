export function isTwEtfFeeIssuerWriteEnabled(): boolean {
  return process.env.TW_ETF_FEE_ISSUER_WRITE?.trim() === "on";
}
