// 現金殖利率 exactly as Yahoo奇摩's own「股利」頁顯示，per the user's「規則是照抄雅虎奇摩」
// correction (2026-11-08): etfEnrich.ts's Yahoo Finance global quoteSummary summaryDetail.yield
// disagreed with Yahoo奇摩's own tw.stock.yahoo.com/quote/{code}.TW/dividend page for TW-listed
// ETFs (same underlying security, two different Yahoo products computing yield differently) --
// this reads Yahoo奇摩's own headline figure (the first/latest row of 歷年股利政策) verbatim
// instead, matching the twQuotePage.ts precedent for 漲跌/漲跌幅.
//
// Table markup (server-rendered, confirmed via plain fetch -- no browser/JS needed): each
// distribution-year row starts with a sticky first column
// `style="position:sticky;min-width:112px"><div class="... Ta(start)">YEAR</div>`, and within
// that row only the 現金殖利率 column's value carries a literal "%" -- 股票股利 is "-" when
// absent, 現金股利/除息日昨收價 are plain numbers. So the first row's first "<span>N%</span>"
// after the year anchor IS 現金殖利率, independent of which of the other columns happen to be
// empty for that row.

export interface YahooTwCashDividendYield {
  year: number;
  yieldPct: number;
}

export class YahooTwDividendRateLimitedError extends Error {
  httpStatus: number;
  constructor(httpStatus: number) {
    super(`YAHOO_TW_DIVIDEND_RATE_LIMITED_${httpStatus}`);
    this.httpStatus = httpStatus;
  }
}

const ROW_ANCHOR = 'position:sticky;min-width:112px';

/** symbol must include the Yahoo suffix, e.g. "00770.TW", "00679B.TWO". */
export async function fetchYahooTwCashDividendYield(symbol: string): Promise<YahooTwCashDividendYield | null> {
  const url = `https://tw.stock.yahoo.com/quote/${encodeURIComponent(symbol)}/dividend`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new YahooTwDividendRateLimitedError(res.status);
  if (!res.ok) return null;

  const html = await res.text();
  const anchorIdx = html.indexOf(ROW_ANCHOR);
  if (anchorIdx === -1) return null; // no 歷年股利政策 table at all -- product has never distributed
  const chunk = html.slice(anchorIdx, anchorIdx + 3000);
  const yearMatch = chunk.match(/Ta\(start\)">(\d{4})<\/div>/);
  const pctMatch = chunk.match(/<span>([\d.]+)%<\/span>/);
  if (!yearMatch || !pctMatch) return null;
  const yieldPct = Number(pctMatch[1]);
  if (!Number.isFinite(yieldPct)) return null;
  return { year: Number(yearMatch[1]), yieldPct };
}
