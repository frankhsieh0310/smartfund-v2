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
  // 2026-11-07（使用者核准，第34輪指令第1點根因修正）: 頁面本身就有標示這些績效數字是「以哪天
  // 的淨值為基準」算出來的（頁面上「註：以 YYYY/MM/DD 為基準日，依淨值計算」、以及embedded
  // JSON裡的 latestPriceDate 欄位）——之前完全沒讀這個欄位，寫入 fund_performances 時一律拿
  // 「抓取當天」當作 date 欄位，不是這批數字實際對應的淨值日期。VERIFIED：排程一天跑好幾次，
  // 同一個「抓取當天」的日期會被重複覆寫；如果某次抓取發生在 Yahoo 自己都還沒把 latestPriceDate
  // 推進到當天之前（也就是 Yahoo 本身淨值資料還落後一天甚至更多），我們還是照樣用「抓取當天」
  // 存進去，等於把「舊淨值算出來的報酬率」誤標成「新日期的報酬率」，隔幾次抓取 latestPriceDate
  // 終於追上、數字又變了，同一個date列就被覆寫成另一批（實際上對應不同基準日）的數字——這才是
  // 使用者回報的「同一檔基金1Y報酬率逐日劇烈跳動」真正根因，不是mapping或解析欄位錯誤。
  asOfDate: string | null; // YYYY-MM-DD，取自頁面的 latestPriceDate（這批績效數字的淨值基準日）
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

  // 同一個 latestPriceDate 字串在頁面上出現不只一次（基金總覽區塊、meta區塊都有），但同一次
  // 頁面載入裡全部都是同一個值（VERIFIED多檔基金皆如此）——直接抓第一個出現的即可，不用追蹤
  // 它實際藏在哪個巢狀物件裡（那個物件的巢狀路徑比較脆弱，字串本身的出現位置穩定得多）。
  const asOfMatch = html.match(/"latestPriceDate":"(\d{4}-\d{2}-\d{2})"/);
  const asOfDate = asOfMatch ? asOfMatch[1] : null;

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
    asOfDate,
  };
}
