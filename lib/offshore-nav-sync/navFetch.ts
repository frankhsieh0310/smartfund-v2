// One Yahoo request per fund: FundServices.fundsPriceHistory, the same internal API verified earlier
// this session to work via plain fetch() with no cookie/crumb/session needed.
export type FetchedNav = { nav: number; navDate: string } | null;

export class RateLimitedError extends Error {
  httpStatus: number;
  constructor(status: number) {
    super(`YAHOO_RATE_LIMITED_${status}`);
    this.httpStatus = status;
  }
}

export async function fetchOffshoreNav(yahooFundId: string): Promise<FetchedNav> {
  const now = new Date();
  const from = new Date(now.getTime() - 10 * 86400000);
  const timeslot = `${from.toISOString().slice(0, 19)}Z-${now.toISOString().slice(0, 19)}Z`;
  const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsPriceHistory;fundId=${encodeURIComponent(yahooFundId)};timeslot=${encodeURIComponent(timeslot)}?intl=tw&lang=zh-Hant-TW&region=TW&site=finance&device=desktop&returnMeta=true`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new RateLimitedError(res.status);
  if (!res.ok) throw new Error(`YAHOO_HTTP_${res.status}`);
  const json: any = await res.json();
  // closePrices/dates come back as arrays of STRINGS (e.g. "27.94"), not numbers -- Number.isFinite()
  // does not coerce, so values must be converted before validation.
  const closePricesRaw: unknown[] | undefined = json?.closePrices ?? json?.data?.closePrices;
  const dates: string[] | undefined = json?.dates ?? json?.data?.dates;
  if (!Array.isArray(closePricesRaw) || !Array.isArray(dates) || closePricesRaw.length === 0) return null;
  const lastIdx = closePricesRaw.length - 1;
  const nav = Number(closePricesRaw[lastIdx]);
  const navDateRaw = dates[lastIdx];
  if (!Number.isFinite(nav) || nav <= 0 || !navDateRaw) return null;
  const navDate = String(navDateRaw).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(navDate)) return null;
  return { nav, navDate };
}
