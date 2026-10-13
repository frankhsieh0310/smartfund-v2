// Day-change (漲跌/漲跌幅) exactly as Yahoo奇摩's own main quote page displays it, per the user's
// "照抄 Yahoo奇摩" rule. Superseded the first attempt at this fix (reading chart.result[0].meta's
// chartPreviousClose/regularMarketPrice from Yahoo's GLOBAL chart API) after re-verifying against the
// live page for 6 TW ETFs post-close: the global API's previousClose routinely disagreed with
// Yahoo奇摩's own displayed "昨收" by enough to throw the computed day-change off by 2-4x, and even
// flipped sign once (0056.TW). Yahoo奇摩's own "昨收" + "成交" fields, read directly from this same
// page, matched all 6 tickers exactly. See docs/specs/yahoo-return-discrepancy.md.
//
// Like twPerformancePage.ts, this is read from the server-rendered HTML directly (no separate XHR
// found for this page either), using the same plain two-span "<label>...</label><span>value</span>"
// pattern Yahoo奇摩 uses throughout its quote pages.

export interface YahooTwDayChange {
  currentPrice: number;
  previousClose: number;
  changePercent: number;
  change: number;
}

export class YahooTwQuoteRateLimitedError extends Error {
  httpStatus: number;
  constructor(httpStatus: number) {
    super(`YAHOO_TW_QUOTE_RATE_LIMITED_${httpStatus}`);
    this.httpStatus = httpStatus;
  }
}

function extractLabeledValue(html: string, label: string): number | null {
  const match = html.match(new RegExp(`>${label}<\\/span><span[^>]*>([0-9.]+)<\\/span>`));
  return match ? Number(match[1]) : null;
}

/** symbol must include the Yahoo suffix, e.g. "0050.TW", "00679B.TWO". */
export async function fetchYahooTwDayChange(symbol: string): Promise<YahooTwDayChange | null> {
  const url = `https://tw.stock.yahoo.com/quote/${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new YahooTwQuoteRateLimitedError(res.status);
  if (!res.ok) return null;

  const html = await res.text();
  const currentPrice = extractLabeledValue(html, "成交");
  const previousClose = extractLabeledValue(html, "昨收");
  if (currentPrice === null || previousClose === null || previousClose === 0) return null;

  const change = currentPrice - previousClose;
  const changePercent = (change / previousClose) * 100;
  return { currentPrice, previousClose, changePercent, change };
}
