import YahooFinance from "yahoo-finance2";

const yahoo = new YahooFinance();

export type YahooFundObservation = {
  providerSymbol: string;
  quoteType: "MUTUALFUND";
  date: Date;
  nav: number;
  currency: string | null;
};

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function fetchYahooFundLatest(providerSymbol: string): Promise<YahooFundObservation> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const quote = await yahoo.quote(providerSymbol) as any;
      if (quote?.quoteType !== "MUTUALFUND") throw new Error(`TYPE_MISMATCH:${quote?.quoteType ?? "UNKNOWN"}`);
      const nav = Number(quote.regularMarketPrice);
      const marketTime = quote.regularMarketTime instanceof Date ? quote.regularMarketTime : new Date(quote.regularMarketTime);
      if (!Number.isFinite(nav) || nav <= 0) throw new Error("NO_DATA:REGULAR_MARKET_PRICE");
      if (Number.isNaN(marketTime.getTime())) throw new Error("INVALID_DATE");
      const date = new Date(`${marketTime.toISOString().slice(0, 10)}T00:00:00.000Z`);
      if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000) throw new Error("INVALID_DATE:FUTURE");
      return { providerSymbol, quoteType: "MUTUALFUND", date, nav, currency: quote.currency ?? null };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/429|rate.?limit/i.test(message) || attempt === 2) throw error;
      await wait(1_000 * 2 ** attempt);
    }
  }
  throw lastError;
}

export type YahooFundHolding = {
  rank: number;
  name: string;
  symbol: string | null;
  weight: number;
};

export type YahooFundHoldingsObservation = {
  providerId: string;
  asOfDate: string;
  sourceUrl: string;
  holdings: YahooFundHolding[];
};

export async function fetchYahooFundHoldings(providerCode: string): Promise<YahooFundHoldingsObservation> {
  const value = providerCode.trim().toUpperCase();
  const providerId = value.endsWith(":FO") ? value : `${value}:FO`;
  if (!/^F[A-Z0-9]+:FO$/.test(providerId)) throw new Error(`INVALID_YAHOO_FUND_ID:${providerCode}`);

  const sourceUrl = `https://tw.stock.yahoo.com/fund/${encodeURIComponent(providerId)}/holdings`;
  const response = await fetch(sourceUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (compatible; SmartFundData/1.0)",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);

  const html = await response.text();
  const match = html.match(/"portfolioHolding":\{"portfolioUpdated":"([^"]+)","portfolios":(\[[\s\S]*?\])\}/);
  if (!match) throw new Error("NO_DATA:PORTFOLIO_HOLDING");
  const asOfDate = match[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error(`INVALID_SOURCE_DATE:${asOfDate}`);

  const rows = JSON.parse(match[2]) as Array<{ astPct?: string | number; securityName?: string; ticker?: string }>;
  const holdings = rows.flatMap((row, index) => {
    const name = row.securityName?.trim();
    const weight = Number(row.astPct);
    if (!name || !Number.isFinite(weight) || weight < 0) return [];
    return [{ rank: index + 1, name, symbol: row.ticker?.trim() || null, weight }];
  });
  if (holdings.length === 0) throw new Error("NO_DATA:EMPTY_PORTFOLIO");
  return { providerId, asOfDate, sourceUrl, holdings };
}

export type YahooFundProfileObservation = {
  providerId: string;
  sourceUrl: string;
  categoryName: string | null;
};

/**
 * Fund "group"/category metadata only — deliberately independent of fetchYahooFundHoldings so a
 * fund with no holdings disclosure (or a holdings-parse failure) can still get its category
 * synced. Same Yahoo TW fund page this repo already scrapes for holdings; parses the embedded
 * page-state JSON's categoryName field (Yahoo's own "基金組別"), the exact raw text — never
 * reclassified. Returns categoryName: null (not an error) when Yahoo genuinely doesn't have one
 * for this fund; only network/identity problems throw.
 */
export async function fetchYahooFundProfile(providerCode: string): Promise<YahooFundProfileObservation> {
  const value = providerCode.trim().toUpperCase();
  const providerId = value.endsWith(":FO") ? value : `${value}:FO`;
  if (!/^F[A-Z0-9]+:FO$/.test(providerId)) throw new Error(`INVALID_YAHOO_FUND_ID:${providerCode}`);

  const sourceUrl = `https://tw.stock.yahoo.com/fund/${encodeURIComponent(providerId)}/holdings`;
  const response = await fetch(sourceUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (compatible; SmartFundData/1.0)",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);

  const html = await response.text();
  // Anchored to this fund's own "id" so a related-fund sidebar entry on the same page can never
  // be picked up instead.
  const idEscaped = providerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`"id":"${idEscaped}"[^}]*?"categoryName":(null|"[^"]*")`));
  const categoryName = match && match[1] !== "null" ? JSON.parse(match[1]) as string : null;
  return { providerId, sourceUrl, categoryName };
}
