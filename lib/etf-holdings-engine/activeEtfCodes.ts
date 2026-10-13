// Taiwan's actively-managed ETF program uses a reserved ticker-suffix convention (never a guess — this
// is the official TWSE/FSC naming rule for the program launched with 00400A onward, later extended to
// 0098xA/D/T for active equity/bond/balanced funds respectively). Passive ETFs never use these suffixes
// in this numeric range (B = passive bond index, L/R = leveraged/inverse, U = commodity futures,
// K = alias/share class). Used only to default the mobile app's "每日持股變化" page to active ETFs —
// every other ETF with a snapshot remains searchable.
export function isActiveEtfCode(code: string): boolean {
  return /^[0-9]+[ADT]$/.test(code);
}
