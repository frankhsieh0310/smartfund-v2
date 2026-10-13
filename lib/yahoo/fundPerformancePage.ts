// Fetches period-return figures as actually DISPLAYED on Yahoo奇摩's own fund "績效表現" page
// (tw.stock.yahoo.com/fund/<yahooFundId>/performance), per the user's "照抄 Yahoo奇摩顯示的數值，
// 不得自己計算" rule. Same technique as lib/yahoo/twPerformancePage.ts (ETFs/stocks): a plain GET
// already contains a clean, labeled JSON block embedded in the server-rendered HTML -- no JS
// execution or separate XHR/API needed (confirmed live 2026-10-14).
//
// The page's own "原幣報酬" column -- the fund's own return in its own quoting currency, which is
// what the rendered table displays under 績效表現 -- is the `"performance":{"returns":[...]}` array.
// Sibling arrays in the same object (`trailingMarketReturns` = 指數/benchmark, `categoryReturns` =
// 同組別/category average) are NOT this fund's own return and are intentionally not read here.
//
// The JSON's "rate" field is ALREADY signed (e.g. "-0.79") even though the rendered page text shows
// only the unsigned magnitude and conveys the sign via a trend CSS class -- unlike the stock/ETF day-
// change page, there is no sign-reconstruction needed here: the embedded JSON itself is the page's
// own underlying data, so reading `rate` directly already is "照抄" the page's own number.

export interface YahooFundPerformance {
  w1: number | null;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  ytd: number | null;
  y1: number | null;
  y3: number | null;
  y5: number | null;
  y10: number | null;
}

export class YahooFundRateLimitedError extends Error {
  httpStatus: number;
  constructor(status: number) {
    super(`YAHOO_FUND_RATE_LIMITED_${status}`);
    this.httpStatus = status;
  }
}

function extractBalancedObject(text: string, keyMarker: string): string | null {
  const keyIndex = text.indexOf(keyMarker);
  if (keyIndex === -1) return null;
  const braceStart = text.indexOf("{", keyIndex);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(braceStart, i + 1);
    }
  }
  return null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

type ReturnEntry = { period?: string; rate?: string };

function rateFor(returns: ReturnEntry[] | undefined, period: string): number | null {
  if (!Array.isArray(returns)) return null;
  const entry = returns.find((r) => r.period === period);
  return entry ? num(entry.rate) : null;
}

/** yahooFundId must include the ":FO" suffix, e.g. "F0000155PU:FO". */
export async function fetchYahooFundPerformance(yahooFundId: string): Promise<YahooFundPerformance | null> {
  const url = `https://tw.stock.yahoo.com/fund/${encodeURIComponent(yahooFundId)}/performance`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new YahooFundRateLimitedError(res.status);
  if (!res.ok) return null;

  const html = await res.text();
  const performanceJson = extractBalancedObject(html, '"performance":{"returns"');
  if (!performanceJson) return null;

  let performance: { returns?: ReturnEntry[] };
  try {
    performance = JSON.parse(performanceJson);
  } catch {
    return null;
  }

  const returns = performance.returns;
  if (!returns) return null;

  return {
    w1: rateFor(returns, "1W"),
    m1: rateFor(returns, "1M"),
    m3: rateFor(returns, "3M"),
    m6: rateFor(returns, "6M"),
    ytd: rateFor(returns, "YTD"),
    y1: rateFor(returns, "1Y"),
    y3: rateFor(returns, "3Y"),
    y5: rateFor(returns, "5Y"),
    y10: rateFor(returns, "10Y"),
  };
}
