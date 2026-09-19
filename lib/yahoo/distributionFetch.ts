// Yahoo chart dividend history with an explicit outcome type. lib/yahoo/productSession.ts#fetchChartFull
// collapses every non-2xx into `null`, which makes "Yahoo has no such symbol" (permanent) and "Yahoo
// throttled us" (retry) indistinguishable. The distribution pipeline needs that difference: NOT_AVAILABLE
// and EMPTY are terminal (mark checked), FAILED is retried on a later run.
//
// Yahoo's chart events carry ONLY { amount, date } where `date` is the ex-dividend date. There is no
// pay / record / declaration date and no frequency in this payload — none is ever inferred here.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type DividendEvent = { exDate: string; amount: number };
export type DividendFetchOutcome =
  | { kind: "OK"; symbol: string; currency: string | null; events: DividendEvent[] } // events may be [] => EMPTY
  | { kind: "NOT_AVAILABLE"; symbol: string; reason: string }
  | { kind: "FAILED"; symbol: string; reason: string };

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Pure: turn a parsed chart JSON body into an outcome (exported for tests). */
export function parseChartDividends(symbol: string, status: number, body: any): DividendFetchOutcome {
  const err = body?.chart?.error;
  if (status === 404 || (err && /not found|no data found|delisted/i.test(`${err.code} ${err.description}`))) {
    return { kind: "NOT_AVAILABLE", symbol, reason: err?.description ?? `HTTP ${status}` };
  }
  if (status === 429) return { kind: "FAILED", symbol, reason: "RATE_429" };
  if (status >= 500) return { kind: "FAILED", symbol, reason: `SERVER_${status}` };
  if (status < 200 || status >= 300) return { kind: "FAILED", symbol, reason: `HTTP_${status}` };
  const res = body?.chart?.result?.[0];
  if (!res) return { kind: "NOT_AVAILABLE", symbol, reason: "NO_RESULT" };
  const raw = res.events?.dividends ? (Object.values(res.events.dividends) as Array<{ date: number; amount: number }>) : [];
  const seen = new Set<string>();
  const events: DividendEvent[] = [];
  for (const d of raw) {
    const amount = Number(d.amount);
    if (!Number.isFinite(amount) || !(amount > 0) || !Number.isFinite(d.date)) continue;
    const exDate = iso(d.date);
    if (seen.has(exDate)) continue; // one event per ex-date per symbol (matches the write identity)
    seen.add(exDate);
    events.push({ exDate, amount: Math.round(amount * 1e6) / 1e6 });
  }
  events.sort((a, b) => a.exDate.localeCompare(b.exDate));
  return { kind: "OK", symbol, currency: res.meta?.currency ?? null, events };
}

export async function fetchDividendHistory(symbol: string, opts: { period1: number }): Promise<DividendFetchOutcome> {
  const p2 = Math.floor((Date.now() + 86_400_000) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${opts.period1}&period2=${p2}&interval=1d&events=div`;
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    let body: any = null;
    try { body = await r.json(); } catch { /* non-JSON body: classified by status below */ }
    return parseChartDividends(symbol, r.status, body);
  } catch (e) {
    return { kind: "FAILED", symbol, reason: e instanceof Error && e.name === "TimeoutError" ? "TIMEOUT" : "NETWORK" };
  }
}
