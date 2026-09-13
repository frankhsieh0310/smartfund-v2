// Reusable Yahoo product-data session for cloud ETF / Fund ingestion.
//
// - chart (v8): NO crumb — full daily price/NAV history + adjclose + dividend/distribution events
// - quote (v7) / quoteSummary (v10) / screener (v1): cookie + crumb (fc.yahoo.com -> /v1/test/getcrumb)
// Reuses the crumb cache + 401-invalidate logic already in lib/services/dataProviders/yahoo/yahooClient.ts.
// Never logs cookie / crumb. No hardcoded secrets. chart stays on the no-crumb path.

import { getAuth, invalidateAuth, authDiag, authAgeSeconds } from "../services/dataProviders/yahoo/yahooClient";

export { authDiag, authAgeSeconds };

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type YahooCandle = {
  date: string; // YYYY-MM-DD (UTC)
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  adjClose: number | null;
  volume: number | null;
};
export type YahooChartFull = {
  symbol: string;
  currency: string | null;
  exchangeName: string | null;
  instrumentType: string | null;
  regularMarketPrice: number | null;
  regularMarketTime: string | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  candles: YahooCandle[];
  dividends: Array<{ date: string; amount: number }>;
};

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Full daily history + distribution events. No crumb. */
export async function fetchChartFull(
  symbol: string,
  opts: { period1?: number; interval?: "1d" | "1wk" | "1mo" } = {},
): Promise<YahooChartFull | null> {
  const p1 = opts.period1 ?? 0;
  const p2 = Math.floor((Date.now() + 86_400_000) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=${opts.interval ?? "1d"}&events=div%2Csplit`;
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) return null;
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) return null;
  const ts: number[] = res.timestamp ?? [];
  const q = res.indicators?.quote?.[0] ?? {};
  const adj: (number | null)[] = res.indicators?.adjclose?.[0]?.adjclose ?? [];
  const m = res.meta ?? {};
  const divs = res.events?.dividends
    ? Object.values(res.events.dividends as Record<string, { date: number; amount: number }>)
        .map((d) => ({ date: iso(d.date), amount: Number(d.amount) }))
        .filter((d) => Number.isFinite(d.amount))
    : [];
  return {
    symbol,
    currency: m.currency ?? null,
    exchangeName: m.exchangeName ?? null,
    instrumentType: m.instrumentType ?? null,
    regularMarketPrice: Number.isFinite(m.regularMarketPrice) ? m.regularMarketPrice : null,
    regularMarketTime: m.regularMarketTime ? iso(m.regularMarketTime) : null,
    fiftyTwoWeekHigh: Number.isFinite(m.fiftyTwoWeekHigh) ? m.fiftyTwoWeekHigh : null,
    fiftyTwoWeekLow: Number.isFinite(m.fiftyTwoWeekLow) ? m.fiftyTwoWeekLow : null,
    candles: ts.map((t, i) => ({
      date: iso(t),
      open: q.open?.[i] ?? null,
      high: q.high?.[i] ?? null,
      low: q.low?.[i] ?? null,
      close: q.close?.[i] ?? null,
      adjClose: adj[i] ?? null,
      volume: q.volume?.[i] ?? null,
    })),
    dividends: divs,
  };
}

// Failure classification for quoteSummary calls, tallied into RateStats so a full-sweep run log
// carries a real breakdown instead of an opaque "failed" count. Never derived from cookie/crumb
// values themselves — only from HTTP status / thrown-error shape.
export type QuoteSummaryFailure =
  | "AUTH_401" | "AUTH_403" | "RATE_429" | "TIMEOUT" | "EMPTY_RESULT"
  | "AUTH_UNAVAILABLE" | "SERVER_5XX" | "OTHER";

/**
 * v10 quoteSummary for one symbol. Crumb; 401/403 -> invalidate + retry once (403 from Yahoo's
 * crumb-gated endpoints commonly means "your crumb doesn't match this session" — same fix as 401,
 * just a different status code Yahoo happens to return for it); 429/5xx -> backoff + retry.
 */
export async function fetchQuoteSummary(
  symbol: string,
  modules: string[],
  stats?: RateStats,
): Promise<{ url: string; result: any } | null> {
  const fail = (reason: QuoteSummaryFailure) => {
    if (!stats) return;
    stats.failures ??= {};
    stats.failures[reason] = (stats.failures[reason] ?? 0) + 1;
    stats.lastFailure = reason; // last-attempt-wins: what a caller should log for THIS symbol
  };
  if (stats) stats.lastFailure = undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (stats) stats.calls++;
    const auth = await getAuth();
    if (!auth) { fail("AUTH_UNAVAILABLE"); if (attempt < 2) { await sleep(1000); continue; } return null; }
    const url =
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
      `?modules=${modules.join(",")}&crumb=${encodeURIComponent(auth.crumb)}`;
    let r: Response;
    try {
      r = await fetch(url, {
        headers: { "user-agent": UA, accept: "application/json", cookie: auth.cookie },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      fail(e instanceof Error && e.name === "TimeoutError" ? "TIMEOUT" : "OTHER");
      if (attempt < 2) continue;
      return null;
    }
    if (r.ok) {
      const j = await r.json();
      const result = j?.quoteSummary?.result?.[0];
      if (!result) { fail("EMPTY_RESULT"); return null; }
      return { url: url.replace(/&crumb=[^&]*/, "&crumb=REDACTED"), result };
    }
    if (r.status === 401) { fail("AUTH_401"); invalidateAuth(); if (stats) stats.crumbRefresh++; continue; }
    if (r.status === 403) { fail("AUTH_403"); invalidateAuth(); if (stats) stats.crumbRefresh++; continue; }
    if (r.status === 429) { fail("RATE_429"); if (stats) stats.rateLimited++; await sleep((attempt + 1) * 4000); continue; }
    if (r.status >= 500) { fail("SERVER_5XX"); await sleep((attempt + 1) * 4000); continue; }
    fail("OTHER");
    return null;
  }
  return null;
}

export type RateStats = {
  calls: number;
  rateLimited: number;
  crumbRefresh: number;
  failures?: Partial<Record<QuoteSummaryFailure, number>>;
  lastFailure?: QuoteSummaryFailure; // last-call-wins; read immediately after a fetchQuoteSummary call
};

export function newRateStats(): RateStats {
  return { calls: 0, rateLimited: 0, crumbRefresh: 0, failures: {} };
}

/** v1 screener page. Crumb. Returns { total, symbols }. */
export async function screenerPage(
  quoteType: "ETF" | "MUTUALFUND",
  operands: any[],
  offset: number,
  size = 25,
  sortField = "fundnetassets",
  stats?: RateStats,
): Promise<{ total: number; symbols: string[]; http: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const auth = await getAuth();
    if (stats) stats.calls++;
    const r = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/screener${auth ? `?crumb=${encodeURIComponent(auth.crumb)}` : ""}`,
      {
        method: "POST",
        headers: {
          "user-agent": UA,
          accept: "application/json",
          "content-type": "application/json",
          ...(auth ? { cookie: auth.cookie } : {}),
        },
        body: JSON.stringify({
          size,
          offset,
          sortField,
          sortType: "DESC",
          quoteType,
          topOperator: "AND",
          query: { operator: "AND", operands },
          userId: "",
          userIdType: "guid",
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (r.ok) {
      const j = await r.json();
      const res = j?.finance?.result?.[0];
      return {
        total: Number(res?.total ?? 0),
        symbols: (res?.quotes ?? []).map((x: any) => x.symbol).filter(Boolean),
        http: 200,
      };
    }
    if (r.status === 401) { invalidateAuth(); if (stats) stats.crumbRefresh++; continue; }
    if (r.status === 429 || r.status >= 500) { if (stats) stats.rateLimited++; await sleep((attempt + 1) * 4000); continue; }
    return { total: 0, symbols: [], http: r.status };
  }
  return { total: 0, symbols: [], http: 0 };
}

export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// helpers for reading Yahoo's {raw,fmt} wrapped numbers
export const rawNum = (v: any): number | null => {
  const x = v && typeof v === "object" && "raw" in v ? v.raw : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
};
export const rawText = (v: any): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
