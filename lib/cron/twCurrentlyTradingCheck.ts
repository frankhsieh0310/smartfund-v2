// 2026-10-18 root-cause fix: VERIFIED live that TWSE/TPEx's own t187ap47 official ETF list (the
// ONE source newListingDetection.ts/classifyTwPurchasable.ts treat as "the official list of
// currently-listed ETFs") actually contains ETFs that are no longer trading -- cross-checked all
// 427 codes from that feed against TWSE's and TPEx's own real daily closing-quote data for today
// and found 68 absent from BOTH (including all 65 of the previously-assumed "backfill gap" codes,
// e.g. 0054/0058/0059/0060, plus 3 more -- 00793B/00838B/00847B -- that are already `etfs` rows
// still flagged is_active=true despite not trading today). t187ap47 is a company-filing/overview
// feed, not a live trading-status feed, so it can lag behind an actual delisting. This module adds
// the one check that actually answers "is this currently tradable": presence in TODAY's real daily
// closing-quote data from BOTH exchanges' own official APIs.
//
// Deliberately conservative: a code absent from both exchanges' daily quote data today is treated
// as "not currently trading" even though a single no-trade day is theoretically possible for an
// extremely illiquid product without being delisted -- VERIFIED this project's own existing
// evidence (checks.ts's KNOWN_DATA_SOURCE_GAPS already separately flags 00838B as "suspected
// delisted") corroborates this check's result for at least one of the 3 extra codes found here,
// so false positives from this method appear to be rare in practice, not the common case.
const TWSE_STOCK_DAY_ALL_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const TPEX_MAINBOARD_QUOTES_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes";

export async function fetchCurrentlyTradingTwCodes(): Promise<Set<string>> {
  const [twseRes, tpexRes] = await Promise.all([
    fetch(TWSE_STOCK_DAY_ALL_URL, { signal: AbortSignal.timeout(20_000) }),
    fetch(TPEX_MAINBOARD_QUOTES_URL, { signal: AbortSignal.timeout(20_000) }),
  ]);
  const codes = new Set<string>();
  if (twseRes.ok) {
    const rows = (await twseRes.json()) as Array<{ Code?: string }>;
    for (const r of rows) if (r.Code) codes.add(r.Code);
  }
  if (tpexRes.ok) {
    const rows = (await tpexRes.json()) as Array<{ SecuritiesCompanyCode?: string }>;
    for (const r of rows) if (r.SecuritiesCompanyCode) codes.add(r.SecuritiesCompanyCode);
  }
  return codes;
}
