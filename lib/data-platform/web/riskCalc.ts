// Self-calculated risk indicators (standard deviation / Sharpe ratio), computed from real price
// history rather than copied from any source — the explicit CLAUDE.md exception for "技術與風險
// 指標可依真實價格計算" (unlike every other displayed number in this app, which must trace to
// Yahoo/official data and never be computed by us). Every caller MUST label the result as
// 本App計算 with the method shown (see RISK_CALC_METHOD_LABEL) so it is never mistaken for a
// Yahoo/official figure.
export type DailyPricePoint = { date: Date; close: number };

export type CalculatedRisk = {
  volatility1yPct: number | null; // annualized standard deviation of daily returns, in percent
  sharpe1y: number | null;
  annualizedReturnPct: number | null; // the return figure the Sharpe ratio itself uses (geometric, annualized)
  observationCount: number;
  riskFreeRatePct: number | null;
};

const TRADING_DAYS_PER_YEAR = 252;

/** `prices` must already be sorted ascending by date and cover the trading days to use (the caller
 * decides the window, e.g. the most recent ~252 trading days for a 1-year figure). */
export function calculateVolatilityAndSharpe(prices: DailyPricePoint[], riskFreeRatePct: number | null): CalculatedRisk {
  const closes = prices.map((p) => p.close).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 20) {
    return { volatility1yPct: null, sharpe1y: null, annualizedReturnPct: null, observationCount: closes.length, riskFreeRatePct };
  }
  const dailyReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) dailyReturns.push(Math.log(closes[i] / closes[i - 1]));

  const mean = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
  const dailyStdDev = Math.sqrt(variance);

  const volatility1yPct = dailyStdDev * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
  // Geometric annualization of the mean daily log return — consistent with how the daily returns
  // themselves were computed (log returns), rather than mixing a simple-return annualization with a
  // log-return volatility.
  const annualizedReturnPct = (Math.exp(mean * TRADING_DAYS_PER_YEAR) - 1) * 100;

  const sharpe1y = riskFreeRatePct != null && volatility1yPct > 0
    ? (annualizedReturnPct - riskFreeRatePct) / volatility1yPct
    : null;

  return { volatility1yPct, sharpe1y, annualizedReturnPct, observationCount: closes.length, riskFreeRatePct };
}

// Shown next to every self-calculated risk figure so it is never mistaken for a Yahoo/official
// number.
export const RISK_CALC_METHOD_LABEL =
  "本App計算：以近1年(252個交易日)每日報酬率的年化標準差為波動率；夏普值=(年化報酬率-無風險利率)/年化波動率。";

// 2026-10-29（使用者核准，USD無風險利率來源修正）: CLOUD_US_TREASURY_SYNC（美國財政部官方
// Daily Treasury Par Yield Curve）已經有每天更新的3個月期公債殖利率（TREASURY_YIELD_3_MO，
// VERIFIED最新到2026-10-26），這比先前暫用的美國2年期公債殖利率更貼近傳統無風險利率定義
// （短天期、幾乎零信用風險），改用它。
export const RISK_FREE_RATE_SOURCES: Record<string, { label: string }> = {
  USD: { label: "美國財政部每日公布3個月期公債殖利率（Daily Treasury Par Yield Curve Rates, TREASURY_YIELD_3_MO）" },
};

// 2026-10-29（使用者核准，TWD/其他幣別無風險利率查證結果）: 查過兩個官方來源都還沒能自動取得——
// 台灣銀行牌告利率頁(rate.bot.com.tw)有機器人防護challenge(proof-of-work)，不准繞過；中央銀行
// 開放資料平台(cpx.cbc.gov.tw/api/OpenData/DataSet?set_id=6022，央行貼放利率/重貼現率)有正式
// API文件，但實際呼叫回傳200且內容是空的(Content-Length:0)，還需要再查正確的呼叫方式。
// 照使用者指示的原則：找不到官方利率來源的幣別，不計算夏普值，在畫面上標示原因，不要用猜的
// 利率或用別的幣別的利率頂替。
export const RISK_FREE_RATE_UNAVAILABLE_REASON: Record<string, string> = {
  TWD: "新台幣無風險利率尚未取得官方自動化來源（台灣銀行牌告利率頁有機器人防護、央行開放資料API目前呼叫無回應內容），暫不計算夏普值",
};
