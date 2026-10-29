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
export const RISK_FREE_RATE_SOURCES: Record<string, { label: string; metricCode: string }> = {
  USD: { label: "美國財政部每日公布3個月期公債殖利率（Daily Treasury Par Yield Curve Rates, TREASURY_YIELD_3_MO）", metricCode: "TREASURY_YIELD_3_MO" },
  // 2026-10-29（使用者核准，改查央行「五大銀行平均存款利率」）: 台灣銀行牌告利率頁
  // (rate.bot.com.tw)有機器人防護(proof-of-work challenge)，不准繞過。改用央行開放資料平台
  // cpx.cbc.gov.tw/api/OpenData/DataSet?set_id=10359（五大銀行存放款利率歷史月資料，VERIFIED
  // 一般fetch即可取得，無防護）——取臺灣銀行/土地銀行/合作金庫/第一銀行/華南銀行（97年11月後
  // 的5大銀行定義）一年期定存機動利率平均。VERIFIED其中4家(臺銀/合庫/一銀/華銀)這份資料集本身
  // 停在民國114年11月(2025-11)沒再更新，只有土地銀行持續更新到115年9月——CLOUD_TW_BANK_RATE_SYNC
  // 固定找「至少3家銀行都有資料」的最新月份，誠實記錄實際月份，不假裝是當月利率。
  TWD: { label: "中央銀行「五大銀行存放款利率」開放資料（一年期定存機動利率平均，CBC_5BANK_1Y_DEPOSIT_AVG）", metricCode: "CBC_5BANK_1Y_DEPOSIT_AVG" },
};

// 其他幣別（非USD/TWD）目前還沒有查到可自動化、不需繞過防護的官方利率來源。照指示：找不到的
// 一律不計算夏普值、標示原因，不要用猜的利率或別的幣別利率頂替。
export const RISK_FREE_RATE_UNAVAILABLE_REASON: Record<string, string> = {};
