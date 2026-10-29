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
// number. US2Y (not a 1-3 month T-bill) is used as the risk-free proxy because it is the shortest
// US Treasury maturity with a currently-fresh daily quote in this database (VERIFIED 2026-10-29:
// US13W/3-month-bill data is stale since 2026-07-09, while US2Y/US5Y/US10Y/US30Y are all current
// through 2026-10-27) — a short but not ultra-short maturity is a defensible, clearly-labeled
// approximation, not a silent substitution.
export const RISK_CALC_METHOD_LABEL =
  "本App計算：以近1年(252個交易日)每日報酬率的年化標準差為波動率；夏普值=(年化報酬率-無風險利率)/年化波動率，" +
  "無風險利率取美國2年期公債殖利率（財政部每日公布，近期3個月期國庫券資料來源已逾3個月未更新，改用此替代）。";
