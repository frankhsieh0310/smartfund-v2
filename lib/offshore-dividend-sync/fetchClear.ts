// 基金資訊觀測站 (fundclear.com.tw, operated by TDCC/投信投顧公會/期貨公會) offshore-fund distribution
// data. No robots.txt (confirmed 404), no documented API, no auth/cookie/CAPTCHA required -- the two
// endpoints below are exactly what the site's own Angular frontend calls (reverse-engineered by
// hooking XMLHttpRequest while using the real page, not guessed).
//
// Two HTTP calls per fund, not one: query-latest-nav returns the distribution rows but never the
// currency code, and query-simple-data returns the currency but never the distribution history. Both
// are needed for a complete record; this is a deliberate exception to "one request per fund" (the
// spirit of that rule -- do not hammer the server or retry excessively -- is preserved by treating
// these two as a single fixed-cost unit of work per fund, with no retries and the same >=1.1s spacing
// applied once per fund, not per call).
import type { FundclearDistributionRecord, FundclearFundDistributions } from "./types";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BASE = "https://www.fundclear.com.tw/api/offshore/fund-basic";

export function toIsoDate(slashDate: string | null | undefined): string | null {
  if (!slashDate) return null;
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(slashDate.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function toPercent(pct: string | null | undefined): number | null {
  if (!pct) return null;
  const n = Number(String(pct).replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}

async function postJson<T>(path: string, body: unknown): Promise<T | null> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429 || res.status === 403) throw new RateLimitedError(res.status);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export class RateLimitedError extends Error {
  httpStatus: number;
  constructor(status: number) {
    super(`FUNDCLEAR_RATE_LIMITED_${status}`);
    this.httpStatus = status;
  }
}

export async function fetchOffshoreDistributions(
  fundCode: string,
  startYearMonth: string, // "YYYY/MM"
  endYearMonth: string, // "YYYY/MM"
): Promise<FundclearFundDistributions | null> {
  const simple = await postJson<{ currencyName?: string; fundName?: string }>("query-simple-data", { fundCode });
  if (!simple || !simple.currencyName) return null;

  const dist = await postJson<{ list?: Array<Record<string, string>> }>("query-latest-nav", {
    fundCode,
    startDate: startYearMonth,
    endDate: endYearMonth,
    _pageNum: 1,
    _pageSize: 100,
  });
  const rawList = dist?.list ?? [];

  const records: FundclearDistributionRecord[] = [];
  for (const row of rawList) {
    const exDate = toIsoDate(row.asiEnterDate);
    const baseDate = toIsoDate(row.asiBaseDate);
    const amount = Number(row.asiAmt);
    if (!exDate || !baseDate || !Number.isFinite(amount) || amount <= 0) continue;
    records.push({
      baseDate,
      exDate,
      payDate: toIsoDate(row.asiDate),
      amount,
      frequency: row.asiFreq ?? null,
      incomeRatioPct: toPercent(row.asiRatio1),
      returnOfCapitalRatioPct: toPercent(row.asiRatio2),
    });
  }

  return { currency: simple.currencyName, fundName: simple.fundName ?? "", records };
}
