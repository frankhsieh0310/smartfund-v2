// lib/services/dataProviders/yahoo/yahooClient.ts
//
// Sprint001 Data Platform — Yahoo Provider V1（Day 2）
//
// Working Code First：這是 Yahoo Provider 的共用底層，Stock / ETF /
// FX / Commodity 四條線都透過這個 Client 打 Yahoo Finance 的兩個公開
// 端點：
//   1. Chart API（歷史價格）：query1.finance.yahoo.com/v8/finance/chart/{symbol}
//   2. Quote API（即時基本資料）：query1.finance.yahoo.com/v7/finance/quote
//
// 這裡不寫 Interface / Abstract Class——依照 Two Implementations Rule，
// 等 MoneyDJ Provider（Day 3）也寫完後，才回頭歸納兩者共用的介面。
// 現在先讓 Yahoo 這條線本身能跑、能寫進資料庫。

const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_QUOTE_BASE = "https://query1.finance.yahoo.com/v7/finance/quote";

// Yahoo 沒有正式免費 API 文件，這是社群長期驗證過可用的公開端點，
// 但沒有 SLA，Rate Limit 未知，這裡保守設定節流（見下方 sleep）。
const REQUEST_DELAY_MS = 300;

export interface YahooChartCandle {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  adjClose: number | null;
}

export interface YahooChartResult {
  symbol: string;
  currency: string | null;
  exchangeName: string | null;
  timezone: string | null;
  instrumentType: string | null;
  httpStatus: number;
  contentType: string | null;
  candles: YahooChartCandle[];
}

export interface YahooQuoteResult {
  symbol: string;
  shortName: string | null;
  longName: string | null;
  currency: string | null;
  exchange: string | null;
  quoteType: string | null; // "EQUITY" | "ETF" | "CURRENCY" | "FUTURE" 等
  regularMarketPrice: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

// ══════════════════════════════════════════════════════════════
// Crumb + Cookie 認證（Day 2 測試發現：Screener API 回傳 401
// "Invalid Crumb"，代表 Yahoo 近期對這個端點加上了認證機制，不是
// 程式邏輯錯誤）。
//
// 流程（社群已驗證的標準做法，yahoo-finance2 等套件採用同一套）：
//   1. GET https://fc.yahoo.com/ 拿到 session cookie
//   2. 帶著這個 cookie GET getcrumb 端點，換到 crumb 字串
//   3. 之後所有請求都要帶上 cookie header + ?crumb= 參數
//
// crumb 會過期，這裡簡單快取在模組變數，過期就重新換一次
// （沒有做精確的過期時間判斷，抓 401 就重新取得，足夠應付目前
// 規模）。
// ══════════════════════════════════════════════════════════════
let cachedCookie: string | null = null;
let cachedCrumb: string | null = null;

async function fetchCrumbAndCookie(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    // Step 1：拿 session cookie
    const cookieRes = await fetch("https://fc.yahoo.com/", {
      headers: COMMON_HEADERS,
      redirect: "manual",
    });
    const setCookie = cookieRes.headers.get("set-cookie");
    if (!setCookie) {
      console.error("[YahooClient] 無法取得 session cookie");
      return null;
    }
    const cookie = setCookie.split(";")[0];

    // Step 2：用 cookie 換 crumb
    const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });
    if (!crumbRes.ok) {
      console.error(`[YahooClient] 取得 crumb 失敗: ${crumbRes.status}`);
      return null;
    }
    const crumb = await crumbRes.text();
    if (!crumb || crumb.includes("<html")) {
      console.error("[YahooClient] crumb 回應格式異常:", crumb.slice(0, 200));
      return null;
    }

    return { cookie, crumb };
  } catch (err) {
    console.error("[YahooClient] 取得 crumb/cookie 失敗:", err);
    return null;
  }
}

async function getAuth(): Promise<{ cookie: string; crumb: string } | null> {
  if (cachedCookie && cachedCrumb) {
    return { cookie: cachedCookie, crumb: cachedCrumb };
  }
  const auth = await fetchCrumbAndCookie();
  if (auth) {
    cachedCookie = auth.cookie;
    cachedCrumb = auth.crumb;
  }
  return auth;
}

// 401 時清快取，下次呼叫會重新取得，避免一直拿過期的 crumb 重試。
function invalidateAuth() {
  cachedCookie = null;
  cachedCrumb = null;
}

// Yahoo Chart API 需要 range + interval 參數。range=10y 涵蓋足夠的
// 歷史深度（跟既有 Stock History 的作法一致，不用另外設計）。
// 導出給需要認證的端點（例如 Screener）使用。Chart/Quote API
// 目前測試起來還不確定是否也需要 crumb——這裡先不強制套用，
// 避免對還沒驗證過需要認證的端點畫蛇添足；如果之後 Chart/Quote
// 也遇到 401，再套用同一套 getAuth()。
export { getAuth, invalidateAuth };

export async function fetchYahooChart(
  symbol: string,
  range: string = "10y",
  interval: string = "1d"
): Promise<YahooChartResult | null> {
  await sleep(REQUEST_DELAY_MS);

  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        // Yahoo 對沒有 User-Agent 的請求有時會拒絕，這裡帶一個常見瀏覽器
        // UA，跟既有 Stock Screener 腳本的作法一致。
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
  } catch (err) {
    console.error(`[YahooClient] fetch 失敗 (${symbol}):`, err);
    return null;
  }

  if (!res.ok) {
    console.error(`[YahooClient] Chart API 非 200 回應 (${symbol}): ${res.status}`);
    return null;
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    console.warn(`[YahooClient] 找不到資料 (${symbol})，可能代碼錯誤或已下市`);
    return null;
  }

  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose ?? [];

  const candles: YahooChartCandle[] = timestamps.map((ts, i) => ({
    date: new Date(ts * 1000),
    open: quote.open?.[i] ?? null,
    high: quote.high?.[i] ?? null,
    low: quote.low?.[i] ?? null,
    close: quote.close?.[i] ?? null,
    volume: quote.volume?.[i] ?? null,
    adjClose: adjClose[i] ?? null,
  }));

  return {
    symbol,
    currency: result.meta?.currency ?? null,
    exchangeName: result.meta?.exchangeName ?? null,
    timezone: result.meta?.exchangeTimezoneName ?? null,
    instrumentType: result.meta?.instrumentType ?? null,
    httpStatus: res.status,
    contentType: res.headers.get("content-type"),
    candles,
  };
}

// Quote API 支援一次查多個 symbol（逗號分隔），用來抓 Master 基本
// 資料（名稱、幣別、交易所、商品類型），比對 Chart API 的 meta 更完整。
export async function fetchYahooQuotes(symbols: string[]): Promise<YahooQuoteResult[]> {
  if (symbols.length === 0) return [];
  await sleep(REQUEST_DELAY_MS);

  const url = `${YAHOO_QUOTE_BASE}?symbols=${symbols.map(encodeURIComponent).join(",")}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
  } catch (err) {
    console.error(`[YahooClient] Quote fetch 失敗:`, err);
    return [];
  }

  if (!res.ok) {
    console.error(`[YahooClient] Quote API 非 200 回應: ${res.status}`);
    return [];
  }

  const json = await res.json();
  const results = json?.quoteResponse?.result ?? [];

  return results.map((r: YahooQuoteResult & { fullExchangeName?: string | null }) => ({
    symbol: r.symbol,
    shortName: r.shortName ?? null,
    longName: r.longName ?? null,
    currency: r.currency ?? null,
    exchange: r.fullExchangeName ?? r.exchange ?? null,
    quoteType: r.quoteType ?? null,
    regularMarketPrice: r.regularMarketPrice ?? null,
  }));
}

/**
 * Incremental Chart API variant.  Unlike `fetchYahooChart(range)`, this only
 * requests the supplied UTC window so daily market jobs never re-download a
 * full historical series.
 */
export async function fetchYahooChartPeriod(
  symbol: string,
  period1: number,
  period2: number
): Promise<YahooChartResult | null> {
  await sleep(REQUEST_DELAY_MS);
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;

  let res: Response;
  try {
    res = await fetch(url, { headers: COMMON_HEADERS });
  } catch (err) {
    console.error(`[YahooClient] incremental chart fetch failed (${symbol}):`, err);
    return null;
  }
  if (!res.ok) {
    console.error(`[YahooClient] incremental chart non-200 (${symbol}): ${res.status}`);
    return null;
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) return null;
  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  return {
    symbol,
    currency: result.meta?.currency ?? null,
    exchangeName: result.meta?.exchangeName ?? null,
    timezone: result.meta?.exchangeTimezoneName ?? null,
    instrumentType: result.meta?.instrumentType ?? null,
    httpStatus: res.status,
    contentType: res.headers.get("content-type"),
    candles: timestamps.map((ts, i) => ({
      date: new Date(ts * 1000),
      open: quote.open?.[i] ?? null,
      high: quote.high?.[i] ?? null,
      low: quote.low?.[i] ?? null,
      close: quote.close?.[i] ?? null,
      volume: quote.volume?.[i] ?? null,
      adjClose: adjClose[i] ?? null,
    })),
  };
}
