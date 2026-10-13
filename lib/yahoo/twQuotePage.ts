// Day-change (漲跌/漲跌幅) exactly as Yahoo奇摩's own main quote page displays it, per the user's
// "照抄 Yahoo奇摩，不得自己計算" rule.
//
// History: first attempt read Yahoo's GLOBAL chart API meta (chartPreviousClose/regularMarketPrice)
// -- disagreed with the page by 2-4x, one sign flip. Second attempt subtracted this page's own
// "昨收"/"成交" fields ourselves -- numerically matched all 6 spot-checked tickers, but the user
// then explicitly ruled out ANY subtraction, even of two values both read from Yahoo奇摩 itself: the
// page already computes and displays "漲跌"/"漲跌幅" directly, so this reads THOSE fields verbatim
// instead of re-deriving them from two other fields.
//
// These two fields render as "<span class="...trend-(up|down)...">(arrow icon)<value></span>" --
// the +/- sign is conveyed only by the "trend-up"/"trend-down" CSS class and the arrow icon's
// border-direction, never a literal "-" character in the text, so the class name is read to apply
// the sign to the always-positive-looking number.

export interface YahooTwDayChange {
  change: number;
  changePercent: number;
}

export class YahooTwQuoteRateLimitedError extends Error {
  httpStatus: number;
  constructor(httpStatus: number) {
    super(`YAHOO_TW_QUOTE_RATE_LIMITED_${httpStatus}`);
    this.httpStatus = httpStatus;
  }
}

function extractTrendValue(html: string, label: string, hasPercent: boolean): number | null {
  const startIdx = html.indexOf(`>${label}</span>`);
  if (startIdx === -1) return null;
  // The label's own value sits within the next ~400 chars (the two nested spans for the trend
  // icon + value); bounded so e.g. "漲跌" doesn't accidentally match inside "漲跌幅"'s own markup.
  const chunk = html.slice(startIdx, startIdx + 400);
  const valueMatch = hasPercent ? chunk.match(/>([0-9.]+)%<\/span>/) : chunk.match(/>([0-9.]+)<\/span>/);
  if (!valueMatch) return null;
  const magnitude = Number(valueMatch[1]);
  if (chunk.includes("trend-down")) return -magnitude;
  return magnitude; // "trend-up" or no trend class (flat/0) both read as positive magnitude
}

/** symbol must include the Yahoo suffix, e.g. "0050.TW", "00679B.TWO". */
export async function fetchYahooTwDayChange(symbol: string): Promise<YahooTwDayChange | null> {
  const url = `https://tw.stock.yahoo.com/quote/${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new YahooTwQuoteRateLimitedError(res.status);
  if (!res.ok) return null;

  const html = await res.text();
  // "漲跌幅" must be read before "漲跌" is searched for, and read independently -- both labels start
  // with the same two characters, but indexOf(">漲跌</span>") only matches the exact 2-character
  // label (not the 3-character "漲跌幅"), so the two extractions don't collide.
  const changePercent = extractTrendValue(html, "漲跌幅", true);
  const change = extractTrendValue(html, "漲跌", false);
  if (changePercent === null || change === null) return null;

  return { change, changePercent };
}
