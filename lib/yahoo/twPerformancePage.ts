// Fetches period-return figures as actually DISPLAYED on Yahoo奇摩's own TW stock/ETF performance
// page (tw.stock.yahoo.com), per the user's "照抄 Yahoo奇摩顯示的數值，不得自己計算" rule. This is
// NOT the global Yahoo Finance API (query1/query2.finance.yahoo.com) -- the two can disagree (see
// docs/specs/yahoo-return-discrepancy.md), and Yahoo奇摩's own displayed number is now the
// authoritative one for TW-listed ETFs/stocks per that rule.
//
// No separate JSON API endpoint was found behind this page (checked the network requests the page
// itself makes — only a sidebar "recommended tickers" XHR, nothing for the performance table itself).
// The data IS present as clean, labeled JSON embedded in the page's `root.App.main = {...}` bootstrap
// script (NOT the rendered HTML text/DOM, which would be far more fragile), under a `"performance"`
// key with `totalReturn` (price-based) and `navReturn` (NAV-based) sub-objects. This function extracts
// just that one balanced-brace JSON sub-object (the surrounding page bootstrap blob is NOT valid JSON
// as a whole — it contains bare `undefined` literals elsewhere — but this specific sub-object is
// self-contained valid JSON once isolated).

export interface YahooTwPerformance {
  asOfDate: string | null; // the page's own disclosed basis date, e.g. "2026/10/12" -> "2026-10-12"
  /** Price-based returns (%), Yahoo奇摩's own "本益比"-adjacent totalReturn block. */
  priceReturn: { w1: number | null; m1: number | null; m3: number | null; m6: number | null; ytd: number | null; y1: number | null; y2: number | null; y3: number | null; y5: number | null; y10: number | null };
  /** NAV-based returns (%) -- this is the block the page's own "績效表現" table actually displays. */
  navReturn: { w1: number | null; m1: number | null; m3: number | null; m6: number | null; ytd: number | null; y1: number | null; y2: number | null; y3: number | null; y5: number | null; y10: number | null };
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

function parseReturnBlock(block: Record<string, unknown> | undefined, prefix: string): YahooTwPerformance["priceReturn"] {
  return {
    w1: num(block?.[`${prefix}_1w`]),
    m1: num(block?.[`${prefix}_1m`]),
    m3: num(block?.[`${prefix}_3m`]),
    m6: num(block?.[`${prefix}_6m`]),
    ytd: num(block?.[`${prefix}Ytd`]),
    y1: num(block?.[`${prefix}_1y`]),
    y2: num(block?.[`${prefix}_2yl`]),
    y3: num(block?.[`${prefix}_3yl`]),
    y5: num(block?.[`${prefix}_5yl`]),
    y10: num(block?.[`${prefix}_10yl`]),
  };
}

export class YahooTwRateLimitedError extends Error {
  httpStatus: number;
  constructor(status: number) {
    super(`YAHOO_TW_RATE_LIMITED_${status}`);
    this.httpStatus = status;
  }
}

/** symbol must include the Yahoo suffix, e.g. "0050.TW", "00679B.TWO". */
export async function fetchYahooTwPerformance(symbol: string): Promise<YahooTwPerformance | null> {
  const url = `https://tw.stock.yahoo.com/quote/${encodeURIComponent(symbol)}/performance`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new YahooTwRateLimitedError(res.status);
  if (!res.ok) return null;

  const html = await res.text();
  const bootstrapMatch = html.match(/root\.App\.main\s*=\s*(\{[\s\S]*?\});\n/);
  if (!bootstrapMatch) return null;

  const performanceJson = extractBalancedObject(bootstrapMatch[1], '"performance":');
  if (!performanceJson) return null;

  let performance: Record<string, unknown>;
  try {
    performance = JSON.parse(performanceJson);
  } catch {
    return null;
  }

  const asOfMatch = html.match(/以\s*(\d{4}\/\d{2}\/\d{2})\s*為基準日/);
  const asOfDate = asOfMatch ? asOfMatch[1].replace(/\//g, "-") : null;

  return {
    asOfDate,
    priceReturn: parseReturnBlock(performance.totalReturn as Record<string, unknown> | undefined, "price"),
    navReturn: parseReturnBlock(performance.navReturn as Record<string, unknown> | undefined, "nav"),
  };
}
