// 2026-11-12（使用者核准定案，台股市值改自行計算）: 市值不再抄雅虎財經香港站（持續被擋），改成
// 「我們資料庫最新收盤價 × 證交所/櫃買中心官方公開已發行股數」。VERIFIED兩個official endpoint
// 都是一次HTTP GET拿回全市場（TWSE約1099檔、TPEx約897檔，2026-11-12實測筆數），不是逐檔抓，
// 完全沒有被節流/被擋的問題，也不用像雅虎那樣控速或冷卻等待。
//   TWSE: https://openapi.twse.com.tw/v1/opendata/t187ap03_L（公司代號/已發行普通股數或TDR原股發行股數）
//   TPEx: https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O（SecuritiesCompanyCode/IssueShares）
// 兩邊都VERIFIED過欄位對得上既有Yahoo來源的流通股數數字量級（2330對過，一致）。401/403/429/5xx
// 一律視為BLOCKED立刻停止，不重試繞過。
const TWSE_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
const TPEX_URL = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O";

export type TwSharesOutstandingOutcome =
  | { status: "OK"; byTicker: Map<string, number>; asOfDate: string }
  | { status: "BLOCKED"; httpStatus: number; source: "TWSE" | "TPEX" }
  | { status: "PARSE_FAILED" };

export async function fetchOfficialTwSharesOutstanding(): Promise<TwSharesOutstandingOutcome> {
  let twseRes: Response, tpexRes: Response;
  try {
    [twseRes, tpexRes] = await Promise.all([
      fetch(TWSE_URL, { signal: AbortSignal.timeout(20_000) }),
      fetch(TPEX_URL, { signal: AbortSignal.timeout(20_000) }),
    ]);
  } catch {
    return { status: "PARSE_FAILED" };
  }
  if (twseRes.status === 401 || twseRes.status === 403 || twseRes.status === 429 || twseRes.status >= 500) {
    return { status: "BLOCKED", httpStatus: twseRes.status, source: "TWSE" };
  }
  if (tpexRes.status === 401 || tpexRes.status === 403 || tpexRes.status === 429 || tpexRes.status >= 500) {
    return { status: "BLOCKED", httpStatus: tpexRes.status, source: "TPEX" };
  }
  if (!twseRes.ok || !tpexRes.ok) return { status: "PARSE_FAILED" };

  const byTicker = new Map<string, number>();
  try {
    const twseRows = (await twseRes.json()) as Array<{ 公司代號?: string; 已發行普通股數或TDR原股發行股數?: string }>;
    for (const r of twseRows) {
      const ticker = r.公司代號?.trim();
      const shares = Number(r.已發行普通股數或TDR原股發行股數);
      if (ticker && Number.isFinite(shares) && shares > 0) byTicker.set(ticker, shares);
    }
    const tpexRows = (await tpexRes.json()) as Array<{ SecuritiesCompanyCode?: string; IssueShares?: string }>;
    for (const r of tpexRows) {
      const ticker = r.SecuritiesCompanyCode?.trim();
      const shares = Number(r.IssueShares);
      if (ticker && Number.isFinite(shares) && shares > 0) byTicker.set(ticker, shares);
    }
  } catch {
    return { status: "PARSE_FAILED" };
  }
  if (!byTicker.size) return { status: "PARSE_FAILED" };
  const asOfDate = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { status: "OK", byTicker, asOfDate };
}
