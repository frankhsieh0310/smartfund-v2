// 境外基金國人持有金額/比重 — FundClear 境外站 query-fund-report（同一個端點，basicData裡
// fundGlobalScope/monthAmtRate兩個欄位，VERIFIED 2026-10-31：頁面本身標「單位：新臺幣」+
// 「國人持有比重%」，是台灣投資人持有金額，不是全球規模，跟fund_offshore_scale_tdcc(TDCC
// 3-2)是完全不同的指標，不可混用、不可互相取代。
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const URL = "https://www.fundclear.com.tw/api/offshore/fund-basic/query-fund-report";

export class FundclearOffshoreRateLimitedError extends Error {
  httpStatus: number;
  constructor(httpStatus: number) {
    super(`FUNDCLEAR_OFFSHORE_HTTP_${httpStatus}`);
    this.httpStatus = httpStatus;
  }
}

export type TwHoldingRow = { twHoldingTwd: number; twHoldingPct: number; yearMonth: string } | null;

export async function fetchFundclearTwHolding(isin: string): Promise<TwHoldingRow> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ fundCode: isin }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403 || res.status === 429) throw new FundclearOffshoreRateLimitedError(res.status);
  if (!res.ok) return null;
  const json = (await res.json()) as { basicData?: { fundGlobalScope?: string; monthAmtRate?: string; monthYM?: string } };
  const b = json.basicData;
  if (!b?.fundGlobalScope || !b?.monthYM) return null;
  const twHoldingTwd = Number(b.fundGlobalScope) * 1_000_000;
  const twHoldingPct = Number(b.monthAmtRate ?? "0");
  if (!Number.isFinite(twHoldingTwd)) return null;
  return { twHoldingTwd, twHoldingPct, yearMonth: `${b.monthYM.slice(0, 4)}-${b.monthYM.slice(4, 6)}` };
}
