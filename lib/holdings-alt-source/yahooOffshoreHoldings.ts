// Alternative offshore-fund holdings source: Yahoo奇摩基金's own summary page embeds a server-rendered
// `portfolioHolding` block directly in the initial HTML (confirmed live 2026-10-13: a plain HTTP GET,
// no JS execution needed, already contains the holdings array) -- same "scrape the server-rendered
// page, no hidden API" shape as this project's other scrapers (SITCA, fundclear).
//
// Reuses the existing offshore-nav-sync:yahoo-mapping checkpoint (production_scheduler_checkpoints)
// for funds.code -> Yahoo fundId resolution instead of re-deriving it -- that mapping was built and
// verified earlier this session for NAV fetching and the fundId format is identical here.
export const YAHOO_HOLDINGS_SOURCE = "YAHOO_FUND_SUMMARY_EMBEDDED";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type YahooHoldingRow = {
  rank: number;
  securityName: string;
  ticker: string | null;
  weightPct: number;
};

export type YahooFundHoldings = {
  asOfDate: string | null; // portfolioUpdated, "YYYY-MM-DD"
  holdings: YahooHoldingRow[];
};

export class YahooRateLimitedError extends Error {
  httpStatus: number;
  constructor(status: number) {
    super(`YAHOO_RATE_LIMITED_${status}`);
    this.httpStatus = status;
  }
}

/** Pulls the `"holdings":{...,"portfolioHolding":{"portfolioUpdated":"...","portfolios":[...]}}` block
 * out of the page's embedded JSON without needing a full JSON parse of the whole (~200KB) page --
 * bracket-balance scan from the first match of the key, same approach as the project's other
 * embedded-JSON scrapes that avoid fragile full-page parsing. */
function extractPortfolioHoldingBlock(html: string): { portfolioUpdated: string | null; portfolios: Array<{ astPct: string; securityName: string; ticker?: string }> } | null {
  const idx = html.indexOf('"portfolioHolding"');
  if (idx === -1) return null;
  const braceStart = html.indexOf("{", idx);
  if (braceStart === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  const jsonSlice = html.slice(braceStart, end);
  try {
    return JSON.parse(jsonSlice);
  } catch {
    return null;
  }
}

export async function fetchYahooOffshoreHoldings(yahooFundId: string): Promise<YahooFundHoldings | null> {
  const url = `https://tw.stock.yahoo.com/fund/${encodeURIComponent(yahooFundId)}/summary`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new YahooRateLimitedError(res.status);
  if (!res.ok) return null;
  const html = await res.text();

  const block = extractPortfolioHoldingBlock(html);
  if (!block || !Array.isArray(block.portfolios)) return null;

  const holdings: YahooHoldingRow[] = [];
  for (const [index, p] of block.portfolios.entries()) {
    const weightPct = Number(p.astPct);
    if (!p.securityName || !Number.isFinite(weightPct)) continue;
    holdings.push({ rank: index + 1, securityName: p.securityName, ticker: p.ticker ?? null, weightPct });
  }
  if (holdings.length === 0) return null;

  return { asOfDate: block.portfolioUpdated ?? null, holdings };
}
